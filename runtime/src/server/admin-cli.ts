import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { DB } from "../shared/sqlite.js";
import { AdminError, validPassword, writeAdmin } from "./accounts.js";

const usage = `用法：lightmoni-admin <init|reset-password> --name <管理员名称> [--password-stdin]
init              仅在没有任何用户时创建管理员
reset-password    重置已有管理员密码并撤销该用户全部登录会话
默认无回显输入并确认密码；自动化可通过 --password-stdin 读取单行密码。
密码至少 8 个字符且最多 72 个 UTF-8 字节，不接受命令行密码参数。
数据目录：LIGHTMONI_DATA（默认 .lightmoni；容器 /data/state）。`;

function options(args: string[]) {
  const action = args.shift();
  if (action !== "init" && action !== "reset-password") throw new AdminError(usage);
  let name: string | undefined, piped = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--name" && name === undefined && args[0] && !args[0].startsWith("--")) name = args.shift();
    else if (arg === "--password-stdin" && !piped) piped = true;
    else throw new AdminError("参数无效，请使用 --help 查看用法");
  }
  if (!name?.trim() || /[\x00-\x1f\x7f]/u.test(name)) throw new AdminError("必须通过 --name 指定有效管理员名称");
  return { action: action as "init" | "reset-password", name, piped };
}

async function stdinPassword(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 74) throw new AdminError("密码输入过长");
    chunks.push(bytes);
  }
  let value: string;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new AdminError("密码必须是有效 UTF-8"); }
  value = value.replace(/\r?\n$/, "");
  if (/[\r\n]/u.test(value)) throw new AdminError("标准输入只能包含一行密码");
  return value;
}

async function hiddenPassword(prompt: string): Promise<string> {
  const input = process.stdin, output = process.stderr;
  if (!input.isTTY || !output.isTTY) throw new AdminError("需要交互终端；自动化请使用 --password-stdin");
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  return new Promise((resolvePassword, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.off("keypress", keypress);
      input.off("end", ended);
      input.off("error", ended);
      process.off("SIGTERM", ended);
      process.off("SIGINT", ended);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
      if (error) reject(error); else resolvePassword(value);
    };
    const ended = () => finish(new AdminError("已取消密码输入"));
    const keypress = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) ended();
      else if (key.name === "return" || key.name === "enter") finish();
      else if (key.name === "backspace") value = [...value].slice(0, -1).join("");
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/u.test(text)) {
        value += text;
        if (Buffer.byteLength(value) > 72) finish(new AdminError("密码最多 72 个 UTF-8 字节"));
      }
    };
    output.write(prompt);
    input.setRawMode(true);
    input.on("keypress", keypress);
    input.once("end", ended);
    input.once("error", ended);
    process.once("SIGTERM", ended);
    process.once("SIGINT", ended);
    input.resume();
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { console.info(usage); return; }
  const { action, name, piped } = options(args);
  const path = join(resolve(process.env.LIGHTMONI_DATA || ".lightmoni"), "lightmoni.db");
  if (action === "reset-password" && !existsSync(path)) throw new AdminError("数据文件不存在，请核对 LIGHTMONI_DATA");
  const password = piped ? await stdinPassword() : await hiddenPassword("新密码：");
  if (!validPassword(password)) throw new AdminError("密码至少 8 个字符且最多 72 个 UTF-8 字节");
  if (!piped && password !== await hiddenPassword("再次输入新密码：")) throw new AdminError("两次密码不一致");
  const db = new DB(path);
  try { await writeAdmin(db, action, name, password); }
  finally { db.close(); }
  console.info(action === "init" ? "管理员已创建" : "管理员密码已更新，旧登录会话已撤销");
}

main().catch(error => {
  console.error(error instanceof AdminError ? error.message : "管理员操作失败，请检查数据目录权限、数据库版本或写入锁");
  process.exitCode = 1;
});
