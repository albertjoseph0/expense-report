const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const SALT_ROUNDS = 10;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key-change-me';

async function hashPassword(password) {
  return await bcrypt.hash(password, SALT_ROUNDS);
}

async function comparePassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

function generateToken(user) {
  return jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

function authenticateToken(req, res, next) {
  const token = req.cookies['auth_token'];
  if (!token) {
    // If it's an HTMX request, we might want to send a redirect header or 401?
    // But for now, simple redirect works for full page loads.
    // For HTMX partials, if session expires, a redirect to login page is usually handled by client side or by returning a full page login which replaces the body?
    // Let's assume standard redirect.
    return res.redirect('/login');
  }

  const user = verifyToken(token);
  if (!user) {
    return res.redirect('/login');
  }

  req.user = user;
  next();
}

module.exports = {
  hashPassword,
  comparePassword,
  generateToken,
  verifyToken,
  authenticateToken
};
