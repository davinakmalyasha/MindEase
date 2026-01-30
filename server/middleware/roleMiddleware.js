const verifyRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ message: "Akses Ditolak! Anda tidak punya izin." });
    }
    next();
  };
};

module.exports = verifyRole;
