/**
 * Interactive one-off: logs into Telegram and prints a StringSession for TG_SESSION.
 *
 * Run from server/ with TG_API_ID and TG_API_HASH already set in .env:
 *   node gen_session.js
 *
 * The printed string is a full account credential — anyone holding it is logged in as this
 * account, with no phone code and no 2FA prompt. Paste it into server/.env (gitignored) and
 * nowhere else. This script used to carry a hardcoded api_id/api_hash pair, which is how they
 * reached a public repo; it reads them from the environment now for that reason.
 *
 * Prompts use node:readline rather than the `input` package, which was imported here but
 * declared in no reachable package.json — so this script threw ERR_MODULE_NOT_FOUND before it
 * asked anything. A built-in keeps the one script needed to *recover* from a leaked session
 * working without first requiring an npm install on the Pi.
 */
import { createInterface } from 'node:readline';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { env } from './src/env.js';

const ask = (prompt) => new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); });
});

// readline has no masked prompt. Writing the prompt directly and then swallowing every echo
// keeps a Telegram 2FA password off the console and out of the terminal's scrollback.
const askHidden = (prompt) => new Promise((resolve) => {
    process.stdout.write(prompt);
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = () => {};
    rl.question('', (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
});

const apiId = Number(env('TG_API_ID'));
const apiHash = env('TG_API_HASH');

if (!apiId || !apiHash) {
    console.error('❌ TG_API_ID and TG_API_HASH must be set in server/.env (see .env.example).');
    console.error('   Get them from https://my.telegram.org → API development tools.');
    process.exit(1);
}

(async () => {
    console.log('Loading interactive login...');
    const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

    await client.start({
        phoneNumber: () => ask('Phone number (with country code): '),
        password: () => askHidden('2FA password (hidden): '),
        phoneCode: () => ask('Code you received: '),
        onError: (err) => console.error(err)
    });

    console.log('\nSet this as TG_SESSION in server/.env — treat it like a password:\n');
    console.log(client.session.save());
    process.exit(0);
})();
