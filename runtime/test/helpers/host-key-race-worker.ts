// Disposable process used only by host-identity persistence race tests.
import { DB } from "../../src/shared/sqlite.js";
import { recordMachineHostKey } from "../../src/server/machine-host-keys.js";
const db = new DB(process.argv[2]), mode = process.argv[3];
if (mode === "race") {
  const expected = db.get<any>("SELECT * FROM managed_machines WHERE id='host'")!;
  process.send?.({ ready: true });
  process.once("message", message => {
    try { const result = recordMachineHostKey(db, expected, Buffer.from((message as any).key, "base64"), "race"); process.send?.({ result }); }
    catch { process.send?.({ error: "race failed" }); }
    finally { db.close(); process.disconnect?.(); }
  });
} else {
  db.native.exec("BEGIN IMMEDIATE");
  db.run("UPDATE test_authorization SET active=0");
  process.send?.({ locked: true });
  setTimeout(() => { db.native.exec("COMMIT"); db.close(); process.disconnect?.(); }, 250);
}
