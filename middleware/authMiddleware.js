const jwt = require('jsonwebtoken');
const pool = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'nativo_web_design_jwt_super_secreto_2026';

async function verificarToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    if (!token) {
      return res.status(401).json({ error: 'Acceso no autorizado. Inicia sesión para continuar.' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    // Verificar que la sesión siga activa en MySQL y no haya expirado
    const [sesiones] = await pool.query(
      'SELECT id FROM sesiones_usuarios WHERE token = ? AND usuario_id = ? AND activa = 1 AND expira_en > NOW() LIMIT 1',
      [token, decoded.id]
    );

    if (sesiones.length === 0) {
      return res.status(401).json({ error: 'Tu sesión ha expirado o fue cerrada. Inicia sesión nuevamente.' });
    }

    const [usuarios] = await pool.query(
      'SELECT id, nombre, usuario, email, rol, activo FROM usuarios WHERE id = ? LIMIT 1',
      [decoded.id]
    );

    if (usuarios.length === 0 || !usuarios[0].activo) {
      return res.status(401).json({ error: 'Usuario inactivo o no encontrado.' });
    }

    req.usuario = usuarios[0];
    req.token = token;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido o expirado. Inicia sesión nuevamente.' });
  }
}

function soloAdmin(req, res, next) {
  if (!req.usuario || req.usuario.rol !== 'admin') {
    return res.status(403).json({ error: 'Permisos insuficientes. Se requiere rol de administrador.' });
  }
  next();
}

module.exports = { verificarToken, soloAdmin, JWT_SECRET };
