// parity: serial
config.reset('displayBatchSize'); config.reset('inspectDepth'); config.reset('inspectCompact'); [config.get('displayBatchSize'), config.set('displayBatchSize', 5), config.get('displayBatchSize'), config.set('nope', 1), config.get('nope'), config.reset('nope'), config.reset('displayBatchSize'), config.get('displayBatchSize'), config.get('inspectDepth'), config.get('inspectCompact'), DBQuery.shellBatchSize]
###
config.reset('displayBatchSize'); config.reset('inspectDepth'); config.reset('inspectCompact'); [config.set('displayBatchSize', 'x'), config.set('inspectDepth', -1), config.set('inspectCompact', 'y'), config.set('redactHistory', 'z')]
###
config.reset('displayBatchSize'); config.reset('inspectDepth'); config.reset('inspectCompact'); db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 12}, (_, i) => ({_id: i}))); config.set('displayBatchSize', 5); db.c.find().sort({_id: 1})
###
config.get('displayBatchSize')
###
config.reset('displayBatchSize'); config.reset('inspectDepth'); config.reset('inspectCompact'); db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 12}, (_, i) => ({_id: i}))); DBQuery.shellBatchSize = 3; db.c.find().sort({_id: 1})
###
config.reset('displayBatchSize'); config.reset('inspectDepth'); config.reset('inspectCompact'); config.set('inspectDepth', 1); ({a: {b: {c: {d: 1}}}})
###
config.reset('displayBatchSize'); config.reset('inspectDepth'); config.reset('inspectCompact'); config.set('inspectCompact', false); ({a: 1, b: [1, 2]})
###
config.reset('displayBatchSize'); config.reset('inspectDepth'); config.reset('inspectCompact'); config.set('inspectCompact', 1); ({a: 1, b: [1, 2], c: {d: {e: 1}}})
###
config.reset('displayBatchSize'); config.reset('inspectDepth'); config.reset('inspectCompact'); config.set('inspectCompact', true); ({a: 1, b: [1, 2], c: {d: {e: 'x'.repeat(60)}}, f: 'y'.repeat(30)})
###
config.reset('displayBatchSize'); config.reset('inspectDepth'); config.reset('inspectCompact'); config.set('inspectDepth', 2); print({a: {b: {c: {d: 1}}}}); printjson({a: {b: {c: {d: 1}}}}); [[[[1]]]]
###
config.reset('displayBatchSize'); config.reset('inspectDepth'); config.reset('inspectCompact'); [config.get('displayBatchSize'), config.get('inspectDepth'), config.get('inspectCompact')]
