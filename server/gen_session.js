import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";

const apiId = REDACTED_TG_API_ID; // REPLACE WITH YOUR API ID
const apiHash = "REDACTED_TG_API_HASH"; // REPLACE WITH YOUR API HASH
const stringSession = new StringSession("");

(async () => {
  console.log("Loading interactive login...");
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.start({
    phoneNumber: async () => await input.text("Please enter your number: "),
    password: async () => await input.text("Please enter your password: "),
    phoneCode: async () => await input.text("Please enter the code you received: "),
    onError: (err) => console.log(err),
  });
  console.log("Save this string to your server config:");
  console.log(client.session.save()); // <--- COPY THIS STRING
  process.exit(0);
})();