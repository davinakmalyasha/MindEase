const express = require("express");
const mysql = require('mysql2');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const jwt = require('jsonwebtoken'); 
const SECRET_KEY = "rahasia_negara_davin_123"; 
const bcrypt = require('bcrypt');
const app = express();
const PORT = 5000;
app.use(cors());
app.use(express.json());
app.use('/images', express.static('public/images'));


const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/images') 
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname))
    }
})

const upload = multer({ storage: storage });


const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'mindease_db' 
});

db.connect(err => {
 if(err) {
    console.error("Database ga nyambung", err);
 } else {
    console.log('Database Nyambung');
 }
});

const verifyToken = (req, res, next) => {
    const tokenHeader = req.headers['authorization']; 

    if (!tokenHeader) {
        return res.status(403).send("Akses Ditolak! Mana tokennya?");
    }
    const token = tokenHeader.split(' ')[1]; 

    if (!token) return res.status(403).send("Token format salah");

    jwt.verify(token, SECRET_KEY, (err, decoded) => {
        if (err) return res.status(500).send("Token Gagal / Kadaluarsa");
        req.userId = decoded.id;
        next(); 
    });
};
app.get('/', (req, res) => {
    res.send('Server MindEase Ready to Rock! 🚀');
});

app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
});