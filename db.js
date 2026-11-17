const mysql = require('mysql2/promise');
require('dotenv').config();

const urlDB = `mysql://${process.env.MYSQLUSER}:${process.env.MYSQL_ROOT_PASSWORD}@${process.env.MYSQLHOST}:${process.env.MYSQLPORT}/${process.env.MYSQLDATABASE}`

const pool = mysql.createPool({
  urlDB
  /*
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'nativo_web_design',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
  */
});

module.exports = pool;
