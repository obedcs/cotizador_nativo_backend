const mysql = require('mysql2/promise');
require('dotenv').config();

const urlDB = `mysql://${process.env.MYSQLUSER}:${process.env.MYSQL_ROOT_PASSWORD}@${process.env.MYSQLHOST}:${process.env.MYSQLPORT}/${process.env.MYSQLDATABASE}`

const pool = mysql.createConnection(urlDB);

module.exports = pool;
