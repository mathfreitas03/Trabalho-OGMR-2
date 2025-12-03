const { Pool } = require("pg");

const pool = new Pool({
    host: "localhost",
    user: "postgres",
    password: "udesc",
    database: "ogmr",
    port: 5432,
    ssl: false,
    max: 10,     
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
});

async function query(sql, params) {
    const res = await pool.query(sql, params);
    return res.rows;
}

module.exports = {
    pool,
    query
};