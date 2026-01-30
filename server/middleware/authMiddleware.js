const jwt = require("jsonwebtoken");
require("dotenv").config();

module.exports = (req, res, next) => {
  const token = req.header("Authorization");

  if (!token)
    return res.status(401).json({ message: "Akses ditolak (No Token)" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(400).json({ message: "Token tidak valid" });
  }
};
