//! Bidirectional JS <-> BSON value conversion.
//!
//! The rules follow what mongosh gets from the Node.js driver's BSON library
//! with its shell defaults (`promoteLongs: false`, `serializeFunctions: true`):
//!
//! * JS numbers become Int32 when they are integers in the int32 range and
//!   Double otherwise; `undefined` is stored as null.
//! * Int64 comes back as a `Long` object, Int32/Double as plain numbers.
//! * Wrapper classes (ObjectId, Long, Decimal128, ...) are implemented in
//!   `js/bson.js` and recognised here through their `_bsontype` tag.

use mongodb::bson::{
    oid::ObjectId, spec::BinarySubtype, Binary, Bson, DateTime, Decimal128, Document, JavaScriptCodeWithScope, Regex,
    Timestamp,
};
use rquickjs::{
    object::Property, Array, Ctx, Exception, Function, Object, Result as JsResult, Type, TypedArray, Value,
};

/// BSON nesting deeper than this is treated as a circular structure.
const MAX_DEPTH: usize = 200;

// Tags understood by `__msh.fromBson` in js/bson.js.
const TAG_OBJECT_ID: i32 = 1;
const TAG_LONG: i32 = 2;
const TAG_DECIMAL: i32 = 3;
const TAG_TIMESTAMP: i32 = 4;
const TAG_BINARY: i32 = 5;
const TAG_MIN_KEY: i32 = 6;
const TAG_MAX_KEY: i32 = 7;
const TAG_REGEXP: i32 = 8;
const TAG_CODE: i32 = 9;
const TAG_DB_POINTER: i32 = 11;
const TAG_DATE: i32 = 12;
const TAG_DB_REF: i32 = 14;

/// Handles to the intrinsics captured at startup, so user code that
/// reassigns `Date` or `RegExp` cannot change how values are converted.
pub struct Conv<'js> {
    ctx: Ctx<'js>,
    from_bson: Function<'js>,
    date_ctor: Object<'js>,
    regexp_ctor: Object<'js>,
    map_ctor: Object<'js>,
    map_entries: Function<'js>,
}

impl<'js> Conv<'js> {
    pub fn new(ctx: &Ctx<'js>) -> JsResult<Self> {
        let msh: Object = ctx.globals().get("__msh")?;
        let intrinsics: Object = msh.get("intrinsics")?;
        Ok(Conv {
            ctx: ctx.clone(),
            from_bson: msh.get("fromBson")?,
            date_ctor: intrinsics.get("Date")?,
            regexp_ctor: intrinsics.get("RegExp")?,
            map_ctor: intrinsics.get("Map")?,
            map_entries: intrinsics.get("mapEntries")?,
        })
    }

    fn type_error<T>(&self, msg: &str) -> JsResult<T> {
        Err(Exception::throw_type(&self.ctx, msg))
    }

    /// Throw a `BSONError`, the class the BSON library reports problems with.
    fn bson_error<T>(&self, msg: &str) -> JsResult<T> {
        let make: Function = self.ctx.globals().get::<_, Object>("__msh")?.get("bsonError")?;
        let error: Value = make.call((msg,))?;
        Err(self.ctx.throw(error))
    }

    // ----------------------------------------------------------------
    // JS -> BSON
    // ----------------------------------------------------------------

    /// Convert a JS value that must be a document (plain object, Map, ...).
    pub fn to_document(&self, value: &Value<'js>) -> JsResult<Document> {
        match self.to_bson(value, 0)? {
            Some(Bson::Document(doc)) => Ok(doc),
            _ => self.type_error("expected a document (plain object)"),
        }
    }

    pub fn to_bson_value(&self, value: &Value<'js>) -> JsResult<Bson> {
        Ok(self.to_bson(value, 0)?.unwrap_or(Bson::Null))
    }

    /// Returns `None` for values that are left out of documents (symbols).
    fn to_bson(&self, value: &Value<'js>, depth: usize) -> JsResult<Option<Bson>> {
        if depth > MAX_DEPTH {
            return self.bson_error("Cannot convert circular structure to BSON");
        }
        Ok(Some(match value.type_of() {
            Type::Uninitialized | Type::Undefined | Type::Null => Bson::Null,
            Type::Bool => Bson::Boolean(value.as_bool().unwrap_or(false)),
            Type::Int => Bson::Int32(value.as_int().unwrap_or(0)),
            Type::Float => number_to_bson(value.as_float().unwrap_or(f64::NAN)),
            Type::String => Bson::String(value.get::<String>()?),
            Type::BigInt => {
                let big = value.as_big_int().cloned().expect("type checked");
                match big.to_i64() {
                    Ok(v) => Bson::Int64(v),
                    Err(_) => return self.bson_error("BigInt is too large to be stored as a 64-bit integer"),
                }
            }
            Type::Symbol => return Ok(None),
            Type::Array => {
                let arr = value.as_array().expect("type checked");
                let len = arr.len();
                let mut out = Vec::with_capacity(len);
                for i in 0..len {
                    let item: Value = arr.get(i)?;
                    out.push(self.to_bson(&item, depth + 1)?.unwrap_or(Bson::Null));
                }
                Bson::Array(out)
            }
            Type::Function | Type::Constructor => {
                // `{ a: MinKey }` passes the constructor itself; it knows how
                // to turn into a value.
                if let Some(obj) = value.as_object() {
                    let to_bson: Value = obj.get("toBSON")?;
                    if let Some(f) = to_bson.as_function() {
                        let replaced: Value = f.call((rquickjs::function::This(obj.clone()),))?;
                        return self.to_bson(&replaced, depth + 1);
                    }
                }
                // serializeFunctions: true -- functions are stored as Code.
                let to_string: Function = self.ctx.globals().get("String")?;
                let code: String = to_string.call((value.clone(),))?;
                Bson::JavaScriptCode(code)
            }
            _ => match value.as_object() {
                Some(obj) => return self.object_to_bson(obj, depth).map(Some),
                None => Bson::Null,
            },
        }))
    }

    fn object_to_bson(&self, obj: &Object<'js>, depth: usize) -> JsResult<Bson> {
        let tag: Value = obj.get("_bsontype")?;
        if let Some(tag) = tag.as_string() {
            let tag = tag.to_string()?;
            if let Some(bson) = self.wrapper_to_bson(obj, &tag, depth)? {
                return Ok(bson);
            }
        }

        if obj.is_instance_of(&self.date_ctor) {
            let get_time: Function = obj.get("getTime")?;
            let ms: f64 = get_time.call((rquickjs::function::This(obj.clone()),))?;
            // An invalid Date is stored as the epoch, as the Node driver does.
            let ms = if ms.is_nan() { 0.0 } else { ms };
            return Ok(Bson::DateTime(DateTime::from_millis(ms as i64)));
        }
        if obj.is_instance_of(&self.regexp_ctor) {
            let pattern: String = obj.get("source")?;
            let flags: String = obj.get("flags")?;
            // Same mapping the Node driver uses: `g` is stored as `s`.
            let mut options = String::new();
            if flags.contains('i') {
                options.push('i');
            }
            if flags.contains('m') {
                options.push('m');
            }
            if flags.contains('g') || flags.contains('s') {
                options.push('s');
            }
            return Ok(Bson::RegularExpression(Regex { pattern, options }));
        }
        if let Some(bytes) = uint8_bytes(obj) {
            return Ok(Bson::Binary(Binary { subtype: BinarySubtype::Generic, bytes }));
        }
        if let Some(buf) = obj.as_array_buffer() {
            // SAFETY: the bytes are copied out before any JS can run and
            // detach or resize the buffer.
            let bytes = unsafe { buf.as_bytes() }.map(|b| b.to_vec()).unwrap_or_default();
            return Ok(Bson::Binary(Binary { subtype: BinarySubtype::Generic, bytes }));
        }

        let to_bson: Value = obj.get("toBSON")?;
        if let Some(f) = to_bson.as_function() {
            let replaced: Value = f.call((rquickjs::function::This(obj.clone()),))?;
            return Ok(self.to_bson(&replaced, depth + 1)?.unwrap_or(Bson::Null));
        }

        let mut doc = Document::new();
        if obj.is_instance_of(&self.map_ctor) {
            let entries: Array = self.map_entries.call((obj.clone(),))?;
            for i in 0..entries.len() {
                let pair: Array = entries.get(i)?;
                let key: rquickjs::Coerced<String> = pair.get(0)?;
                let value: Value = pair.get(1)?;
                if let Some(bson) = self.to_bson(&value, depth + 1)? {
                    self.check_key(&key.0)?;
                    doc.insert(key.0, bson);
                }
            }
            return Ok(Bson::Document(doc));
        }
        for key in obj.keys::<String>() {
            let key = key?;
            let value: Value = obj.get(key.as_str())?;
            if let Some(bson) = self.to_bson(&value, depth + 1)? {
                self.check_key(&key)?;
                doc.insert(key, bson);
            }
        }
        Ok(Bson::Document(doc))
    }

    fn check_key(&self, key: &str) -> JsResult<()> {
        if key.contains('\0') {
            return self.bson_error(&format!("BSON keys cannot contain null bytes, found: {key:?}"));
        }
        Ok(())
    }

    fn wrapper_to_bson(&self, obj: &Object<'js>, tag: &str, depth: usize) -> JsResult<Option<Bson>> {
        Ok(Some(match tag {
            "ObjectId" | "ObjectID" => {
                let buffer: Object = obj.get("buffer")?;
                match uint8_bytes(&buffer).and_then(|b| <[u8; 12]>::try_from(b).ok()) {
                    Some(raw) => Bson::ObjectId(ObjectId::from_bytes(raw)),
                    None => return self.bson_error("invalid ObjectId"),
                }
            }
            "Long" => {
                let low: i32 = obj.get("low")?;
                let high: i32 = obj.get("high")?;
                Bson::Int64(((high as i64) << 32) | (low as u32 as i64))
            }
            "Timestamp" => {
                let low: i32 = obj.get("low")?;
                let high: i32 = obj.get("high")?;
                Bson::Timestamp(Timestamp { time: high as u32, increment: low as u32 })
            }
            "Int32" => {
                let v: f64 = obj.get("value")?;
                Bson::Int32(v as i32)
            }
            "Double" => {
                let v: f64 = obj.get("value")?;
                Bson::Double(v)
            }
            "Decimal128" => {
                let bytes: Object = obj.get("bytes")?;
                match uint8_bytes(&bytes).and_then(|b| <[u8; 16]>::try_from(b).ok()) {
                    Some(raw) => Bson::Decimal128(Decimal128::from_bytes(raw)),
                    None => return self.bson_error("invalid Decimal128"),
                }
            }
            "Binary" | "UUID" => {
                let buffer: Object = obj.get("buffer")?;
                let subtype: i32 = obj.get("sub_type")?;
                let position: Value = obj.get("position")?;
                let mut bytes = uint8_bytes(&buffer).unwrap_or_default();
                if let Some(pos) = position.as_number() {
                    bytes.truncate(pos.max(0.0) as usize);
                }
                Bson::Binary(Binary { subtype: BinarySubtype::from(subtype as u8), bytes })
            }
            "MinKey" => Bson::MinKey,
            "MaxKey" => Bson::MaxKey,
            "BSONRegExp" => {
                let pattern: String = obj.get("pattern")?;
                let options: String = obj.get("options")?;
                Bson::RegularExpression(Regex { pattern, options })
            }
            "BSONSymbol" => Bson::Symbol(obj.get("value")?),
            "Code" => {
                let code: rquickjs::Coerced<String> = obj.get("code")?;
                let scope: Value = obj.get("scope")?;
                if scope.is_object() {
                    Bson::JavaScriptCodeWithScope(JavaScriptCodeWithScope {
                        code: code.0,
                        scope: self.to_document(&scope)?,
                    })
                } else {
                    Bson::JavaScriptCode(code.0)
                }
            }
            "DBRef" => {
                let mut doc = Document::new();
                let collection: String = obj.get("collection")?;
                doc.insert("$ref", collection);
                let oid: Value = obj.get("oid")?;
                doc.insert("$id", self.to_bson(&oid, depth + 1)?.unwrap_or(Bson::Null));
                let db: Value = obj.get("db")?;
                if let Some(db) = db.as_string() {
                    doc.insert("$db", db.to_string()?);
                }
                let fields: Value = obj.get("fields")?;
                if fields.is_object() {
                    for (k, v) in self.to_document(&fields)? {
                        doc.insert(k, v);
                    }
                }
                Bson::Document(doc)
            }
            _ => return Ok(None),
        }))
    }

    // ----------------------------------------------------------------
    // BSON -> JS
    // ----------------------------------------------------------------

    pub fn document_to_js(&self, doc: &Document) -> JsResult<Value<'js>> {
        let obj = Object::new(self.ctx.clone())?;
        for (key, value) in doc {
            let value = self.to_js(value)?;
            if key == "__proto__" {
                // A plain assignment would replace the prototype.
                obj.prop(key.as_str(), Property::from(value).writable().enumerable().configurable())?;
            } else {
                obj.set(key.as_str(), value)?;
            }
        }
        if is_db_ref(doc) {
            return self.from_bson.call((TAG_DB_REF, obj));
        }
        Ok(obj.into_value())
    }

    pub fn to_js(&self, value: &Bson) -> JsResult<Value<'js>> {
        let ctx = &self.ctx;
        Ok(match value {
            // new_float keeps negative zero, which new_number would fold to 0.
            Bson::Double(v) => Value::new_float(ctx.clone(), *v),
            Bson::String(s) => rquickjs::String::from_str(ctx.clone(), s)?.into_value(),
            Bson::Document(doc) => self.document_to_js(doc)?,
            Bson::Array(items) => {
                let arr = Array::new(ctx.clone())?;
                for (i, item) in items.iter().enumerate() {
                    arr.set(i, self.to_js(item)?)?;
                }
                arr.into_value()
            }
            Bson::Boolean(b) => Value::new_bool(ctx.clone(), *b),
            Bson::Null => Value::new_null(ctx.clone()),
            Bson::Undefined => Value::new_undefined(ctx.clone()),
            Bson::Int32(v) => Value::new_int(ctx.clone(), *v),
            Bson::Int64(v) => self.from_bson.call((TAG_LONG, *v as i32, (*v >> 32) as i32))?,
            Bson::ObjectId(oid) => {
                let bytes = TypedArray::<u8>::new(ctx.clone(), oid.bytes().to_vec())?;
                self.from_bson.call((TAG_OBJECT_ID, bytes))?
            }
            Bson::DateTime(dt) => self.from_bson.call((TAG_DATE, dt.timestamp_millis() as f64))?,
            Bson::Decimal128(d) => {
                let bytes = TypedArray::<u8>::new(ctx.clone(), d.bytes().to_vec())?;
                self.from_bson.call((TAG_DECIMAL, bytes))?
            }
            Bson::Timestamp(ts) => self.from_bson.call((TAG_TIMESTAMP, ts.time as f64, ts.increment as f64))?,
            Bson::Binary(bin) => {
                let bytes = TypedArray::<u8>::new(ctx.clone(), bin.bytes.clone())?;
                self.from_bson.call((TAG_BINARY, bytes, u8::from(bin.subtype) as i32))?
            }
            Bson::MinKey => self.from_bson.call((TAG_MIN_KEY,))?,
            Bson::MaxKey => self.from_bson.call((TAG_MAX_KEY,))?,
            Bson::RegularExpression(re) => {
                self.from_bson.call((TAG_REGEXP, re.pattern.as_str(), re.options.as_str()))?
            }
            Bson::JavaScriptCode(code) => self.from_bson.call((TAG_CODE, code.as_str()))?,
            Bson::JavaScriptCodeWithScope(cws) => {
                let scope = self.document_to_js(&cws.scope)?;
                self.from_bson.call((TAG_CODE, cws.code.as_str(), scope))?
            }
            // promoteValues: deprecated symbols come back as plain strings.
            Bson::Symbol(s) => rquickjs::String::from_str(ctx.clone(), s)?.into_value(),
            Bson::DbPointer(_) => {
                // The driver type keeps its fields private; go through its
                // extended JSON form to read them.
                let ext = value.clone().into_canonical_extjson();
                let ns = ext["$dbPointer"]["$ref"].as_str().unwrap_or_default().to_string();
                let id = ext["$dbPointer"]["$id"]["$oid"].as_str().unwrap_or_default();
                let id = ObjectId::parse_str(id).map(|oid| oid.bytes().to_vec()).unwrap_or_else(|_| vec![0; 12]);
                self.from_bson.call((TAG_DB_POINTER, ns, TypedArray::<u8>::new(ctx.clone(), id)?))?
            }
        })
    }
}

fn number_to_bson(v: f64) -> Bson {
    let is_negative_zero = v == 0.0 && v.is_sign_negative();
    if !is_negative_zero && v.fract() == 0.0 && v >= i32::MIN as f64 && v <= i32::MAX as f64 {
        Bson::Int32(v as i32)
    } else {
        Bson::Double(v)
    }
}

/// The bytes of a `Uint8Array`, or `None` when the object is something else.
pub fn uint8_bytes(obj: &Object<'_>) -> Option<Vec<u8>> {
    let arr = obj.as_typed_array::<u8>()?;
    // SAFETY: the bytes are copied out before any JS can run and detach or
    // resize the underlying buffer.
    Some(unsafe { arr.as_bytes() }.map(|b| b.to_vec()).unwrap_or_default())
}

/// Mirrors the BSON library's check for documents that deserialize to DBRef.
fn is_db_ref(doc: &Document) -> bool {
    if !matches!(doc.get("$ref"), Some(Bson::String(_))) {
        return false;
    }
    match doc.get("$id") {
        None | Some(Bson::Null) | Some(Bson::Undefined) => return false,
        _ => {}
    }
    match doc.get("$db") {
        None | Some(Bson::Null) | Some(Bson::String(_)) => {}
        _ => return false,
    }
    doc.keys().filter(|k| k.starts_with('$')).all(|k| matches!(k.as_str(), "$ref" | "$id" | "$db"))
}
