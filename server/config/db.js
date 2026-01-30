// server/config/db.js
const mysql = require('mysql2');
require('dotenv').config();

const db = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'mindease_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Ubah jadi promise base biar bisa pakai async/await (Modern)
const dbPromise = db.promise();

module.exports = dbPromise;