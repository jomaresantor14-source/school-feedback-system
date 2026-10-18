require('dotenv').config();
const mysql = require('mysql2/promise');

// A connection pool keeps working after MySQL closes idle connections,
// unlike a single connection which stops working until the app restarts.
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'school_feedback_system',
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4'
});

// Runs several queries as one all-or-nothing unit.
async function withTransaction(work) {
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        const result = await work(connection);
        await connection.commit();
        return result;
    } catch (err) {
        try {
            await connection.rollback();
        } catch (rollbackErr) {
            console.error('Rollback failed:', rollbackErr.message);
        }
        throw err;
    } finally {
        connection.release();
    }
}

async function checkConnection() {
    try {
        await pool.query('SELECT 1');
        console.log('Connected to MySQL database!');
        return true;
    } catch (err) {
        console.error('Database connection failed:', err.message);
        console.error(
            'Check that MySQL is running and that the DB_* values in your .env file are correct.'
        );
        return false;
    }
}

module.exports = {
    pool,
    query: (...args) => pool.query(...args),
    withTransaction,
    checkConnection
};
