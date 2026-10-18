// Sets a new password for an existing staff account.
// Usage:  npm run set-password -- admin@school.edu "a-new-long-password"
require('dotenv').config();

const bcrypt = require('bcrypt');
const db = require('../config/db');

async function main() {
    const [email, password] = process.argv.slice(2);

    if (!email || !password) {
        console.error('Usage: npm run set-password -- <email> "<new password>"');
        process.exit(1);
    }

    if (password.length < 12) {
        console.error('Use a password with at least 12 characters.');
        process.exit(1);
    }

    const hash = await bcrypt.hash(password, 12);
    const [result] = await db.query(
        'UPDATE users SET password_hash = ? WHERE email = ?',
        [hash, email.trim().toLowerCase()]
    );

    if (result.affectedRows === 0) {
        console.error(`No account found for ${email}.`);
        process.exit(1);
    }

    console.log(`Password updated for ${email}.`);
}

main()
    .catch((err) => {
        console.error('Could not update the password:', err.message);
        process.exitCode = 1;
    })
    .finally(() => db.pool.end());
