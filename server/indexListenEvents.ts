import { Connection, clusterApiUrl, PublicKey } from "@solana/web3.js";

const SOLANA_RPC_URL =
  "https://mainnet.helius-rpc.com/?api-key=88e029e3-9c89-4b1a-a3f1-df636c0c0d44";

const connection = new Connection(SOLANA_RPC_URL, "confirmed");

async function main() {
  const subId = connection.onLogs(
    "all",
    async (logInfo) => {
      try {
        const { signature, err, logs } = logInfo;
        console.log("signature : ", signature);

        if (err) console.warn("⚠️ Transaction failed:", err);

        for (const raw of logs) {
          if (!raw.startsWith("Program log:")) continue;

          const text = raw.slice("Program log:".length).trim();
          let eventName = null;
          let payload = null;

          if (text.startsWith("Event:")) {
            const [, rest] = text.split("Event:");
            const spaceIdx = rest.indexOf(" ");
            eventName = rest.slice(0, spaceIdx);
            const jsonPart = rest.slice(spaceIdx).trim();
            try {
              payload = JSON.parse(jsonPart);
            } catch {
              payload = { raw: jsonPart };
            }
          } else {
            payload = { raw: text };
          }
          console.log("eventName : ", eventName);
          console.log("payload : ", payload);
        }
      } catch (e) {
        console.error("error handling logs:", e);
      }
    },
    "confirmed"
  );

  console.log(`Listening for logs (subscription id ${subId})…`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
