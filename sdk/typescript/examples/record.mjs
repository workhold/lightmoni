import {createLightMoni} from '@lightmoni/sdk';
const moni = createLightMoni({service:'database-api', env:'test'});
const table = process.env.LIGHTMONI_TABLE ?? 'business';
// Call after each database request; aggregation and delivery are automatic.
moni.record(table, 'db.query.duration_ms', {key1:'telecom',key2:'zhejiang'}, 128, 1);
// Total spending 100 for 5 people, without their individual distribution.
moni.record(table, 'restaurant.spend', {}, 100, 5);
await moni.shutdown({timeoutMs:5000});
