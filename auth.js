const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const SALT_ROUNDS = 10;
const JWT_EXPIRY = '7d';

function getSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('JWT_SECRET environment variable is required');
    }
    return secret;
}

async function hashPassword(plain) {
    return bcrypt.hash(plain, SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
    return bcrypt.compare(plain, hash);
}

function generateToken(user) {
    return jwt.sign(
        { id: user.id, username: user.username },
        getSecret(),
        { expiresIn: JWT_EXPIRY }
    );
}

function verifyToken(token) {
    return jwt.verify(token, getSecret());
}

/**
 * Express middleware that checks for a valid JWT in cookies.
 * - On success: sets req.user and calls next()
 * - On failure for GET requests: redirects to /login
 * - On failure for non-GET (htmx/AJAX): returns 401
 */
function requireAuth(req, res, next) {
    const token = req.cookies && req.cookies.token;

    if (!token) {
        return handleUnauthorized(req, res);
    }

    try {
        const decoded = verifyToken(token);
        req.user = decoded;
        next();
    } catch (err) {
        return handleUnauthorized(req, res);
    }
}

function handleUnauthorized(req, res) {
    // Clear any invalid/expired cookie
    res.clearCookie('token');

    if (req.method === 'GET' && !req.headers['hx-request']) {
        return res.redirect('/login');
    }

    // For htmx requests, send a redirect header that htmx will follow
    if (req.headers['hx-request']) {
        res.set('HX-Redirect', '/login');
        return res.status(401).send('');
    }

    return res.status(401).send('Unauthorized');
}

module.exports = {
    hashPassword,
    verifyPassword,
    generateToken,
    verifyToken,
    requireAuth,
};
