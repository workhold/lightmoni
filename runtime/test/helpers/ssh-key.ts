import ssh2 from "ssh2";
/** In-memory, isolated key material; no user's SSH files are ever read. */
export const fixturePrivateKey = () => {
  // ssh2's generator occasionally produces invalid OpenSSH padding. Validate
  // the isolated fixture so that parser rejection tests remain intentional.
  for (let attempt=0;attempt<10;attempt++) {
    const privateKey=ssh2.utils.generateKeyPairSync("ed25519").private.trim();
    const parsed=ssh2.utils.parseKey(privateKey);
    if (!(parsed instanceof Error) && parsed.isPrivateKey()) return privateKey;
  }
  throw Error("failed to generate a valid isolated SSH fixture");
};
