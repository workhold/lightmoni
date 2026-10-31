import {dockerFixture} from './docker-control-fixture.js';
const fixture=await dockerFixture();
let polling=false;
const timer=setInterval(()=>{fixture.advance(500);fixture.db.run('UPDATE agents SET last_seen=?',fixture.deps.now().toISOString());if(!polling){polling=true;void fixture.runner.pollOnce().catch(()=>{}).finally(()=>{polling=false})}},500);
process.stdout.write(JSON.stringify({base:fixture.base})+'\n');
async function close(){clearInterval(timer);await fixture.close();process.exit(0)}
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
