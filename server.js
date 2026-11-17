const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
require('dotenv').config();

const pool = require('./db');
const { generarCotizacionPDF } = require('./pdfGenerator');
const { verificarToken, soloAdmin, JWT_SECRET } = require('./middleware/authMiddleware');

const app = express();
app.use(cors());
app.use(express.json());

// Servir PDFs generados de forma estática
app.use('/pdfs', express.static(path.join(__dirname, 'pdfs')));

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 465,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Garantiza que las tablas de autenticación y el usuario admin inicial existan al iniciar
async function inicializarAutenticacion() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(120) NOT NULL,
        usuario VARCHAR(60) NOT NULL UNIQUE,
        email VARCHAR(150) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        rol ENUM('admin', 'ventas') NOT NULL DEFAULT 'admin',
        activo TINYINT(1) NOT NULL DEFAULT 1,
        ultimo_acceso TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sesiones_usuarios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        token VARCHAR(512) NOT NULL,
        ip_origen VARCHAR(64) DEFAULT NULL,
        user_agent VARCHAR(255) DEFAULT NULL,
        expira_en DATETIME NOT NULL,
        activa TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_sesiones_usuario
          FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
          ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);

    const [existentes] = await pool.query('SELECT id FROM usuarios LIMIT 1');
    if (existentes.length === 0) {
      const hashInicial = await bcrypt.hash('Nativo2026!', 10);
      await pool.query(
        'INSERT INTO usuarios (nombre, usuario, email, password_hash, rol, activo) VALUES (?, ?, ?, ?, ?, 1)',
        ['Administrador Nativo', 'admin', 'admin@nativowebdesign.com', hashInicial, 'admin']
      );
      console.log('Usuario administrador inicial creado: admin / Nativo2026!');
    }
  } catch (err) {
    console.warn('Aviso al verificar tablas de autenticación:', err.message);
  }
}

// ==========================================
// RUTAS PÚBLICAS DE AUTENTICACIÓN (LOGIN)
// ==========================================

app.post('/api/auth/login', async (req, res) => {
  try {
    const { identificador, password } = req.body;

    if (!identificador || !password) {
      return res.status(400).json({ error: 'Ingresa tu usuario (o correo) y contraseña.' });
    }

    const [rows] = await pool.query(
      'SELECT * FROM usuarios WHERE (usuario = ? OR email = ?) LIMIT 1',
      [identificador.trim(), identificador.trim()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }

    const user = rows[0];

    if (!user.activo) {
      return res.status(403).json({ error: 'Esta cuenta se encuentra desactivada. Contacta al administrador.' });
    }

    const passwordValida = await bcrypt.compare(password, user.password_hash);
    if (!passwordValida) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }

    const horasExpiracion = Number(process.env.JWT_EXPIRES_HOURS) || 12;
    const payloadToken = {
      id: user.id,
      nombre: user.nombre,
      usuario: user.usuario,
      email: user.email,
      rol: user.rol
    };

    const token = jwt.sign(payloadToken, JWT_SECRET, { expiresIn: `${horasExpiracion}h` });
    const expiraEn = new Date(Date.now() + horasExpiracion * 60 * 60 * 1000);

    // Registrar sesión activa en MySQL
    await pool.query(
      'INSERT INTO sesiones_usuarios (usuario_id, token, ip_origen, user_agent, expira_en, activa) VALUES (?, ?, ?, ?, ?, 1)',
      [
        user.id,
        token,
        req.ip || null,
        (req.headers['user-agent'] || '').slice(0, 250),
        expiraEn
      ]
    );

    await pool.query('UPDATE usuarios SET ultimo_acceso = NOW() WHERE id = ?', [user.id]);

    res.json({
      mensaje: `Bienvenido, ${user.nombre}`,
      token,
      usuario: payloadToken
    });
  } catch (error) {
    console.error('Error en /api/auth/login:', error);
    res.status(500).json({ error: 'Error interno al iniciar sesión en el servidor.' });
  }
});

app.get('/api/auth/perfil', verificarToken, (req, res) => {
  res.json({ usuario: req.usuario });
});

app.post('/api/auth/logout', verificarToken, async (req, res) => {
  try {
    await pool.query('UPDATE sesiones_usuarios SET activa = 0 WHERE token = ?', [req.token]);
    res.json({ mensaje: 'Sesión cerrada correctamente.' });
  } catch (error) {
    res.status(500).json({ error: 'Error al cerrar la sesión.' });
  }
});

// ==========================================
// GESTIÓN DE USUARIOS (SOLO ADMINISTRADOR)
// ==========================================

app.get('/api/usuarios', verificarToken, soloAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, nombre, usuario, email, rol, activo, ultimo_acceso, created_at FROM usuarios ORDER BY id ASC'
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al consultar la lista de usuarios.' });
  }
});

app.post('/api/usuarios', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { nombre, usuario, email, password, rol } = req.body;
    if (!nombre || !usuario || !email || !password) {
      return res.status(400).json({ error: 'Todos los campos son obligatorios para crear el usuario.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO usuarios (nombre, usuario, email, password_hash, rol, activo) VALUES (?, ?, ?, ?, ?, 1)',
      [nombre.trim(), usuario.trim(), email.trim(), passwordHash, rol === 'ventas' ? 'ventas' : 'admin']
    );

    res.status(201).json({
      id: result.insertId,
      nombre: nombre.trim(),
      usuario: usuario.trim(),
      email: email.trim(),
      rol: rol === 'ventas' ? 'ventas' : 'admin',
      activo: 1
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'El nombre de usuario o correo electrónico ya está registrado.' });
    }
    res.status(500).json({ error: 'No se pudo crear el usuario en MySQL.' });
  }
});

app.patch('/api/usuarios/:id/estado', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { activo } = req.body;

    if (Number(id) === req.usuario.id && !activo) {
      return res.status(400).json({ error: 'No puedes desactivar tu propia cuenta activa.' });
    }

    await pool.query('UPDATE usuarios SET activo = ? WHERE id = ?', [activo ? 1 : 0, id]);
    if (!activo) {
      await pool.query('UPDATE sesiones_usuarios SET activa = 0 WHERE usuario_id = ?', [id]);
    }
    res.json({ mensaje: 'Estado del usuario actualizado.' });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar el estado del usuario.' });
  }
});

app.patch('/api/usuarios/:id/password', verificarToken, soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE usuarios SET password_hash = ? WHERE id = ?', [passwordHash, id]);
    res.json({ mensaje: 'Contraseña actualizada correctamente.' });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar la contraseña.' });
  }
});

// ==========================================
// RUTAS PROTEGIDAS: CATÁLOGO DE SERVICIOS
// ==========================================

app.get('/api/servicios', verificarToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM servicios_catalogo WHERE activo = 1 ORDER BY id ASC'
    );
    res.json(rows);
  } catch (error) {
    console.error('Error al obtener catálogo de servicios:', error);
    res.status(500).json({ error: 'Error al consultar el catálogo de servicios en MySQL' });
  }
});

app.post('/api/servicios', verificarToken, async (req, res) => {
  try {
    const { descripcion, detalle, precio_unitario } = req.body;
    if (!descripcion) {
      return res.status(400).json({ error: 'La descripción del servicio es obligatoria.' });
    }
    const [result] = await pool.query(
      'INSERT INTO servicios_catalogo (descripcion, detalle, precio_unitario) VALUES (?, ?, ?)',
      [descripcion, detalle || null, Number(precio_unitario || 0)]
    );
    res.status(201).json({
      id: result.insertId,
      descripcion,
      detalle: detalle || '',
      precio_unitario: Number(precio_unitario || 0)
    });
  } catch (error) {
    console.error('Error al crear servicio:', error);
    res.status(500).json({ error: 'No se pudo guardar el servicio en el catálogo.' });
  }
});

app.put('/api/servicios/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { descripcion, detalle, precio_unitario } = req.body;
    await pool.query(
      'UPDATE servicios_catalogo SET descripcion = ?, detalle = ?, precio_unitario = ? WHERE id = ?',
      [descripcion, detalle || null, Number(precio_unitario || 0), id]
    );
    res.json({ mensaje: 'Servicio actualizado correctamente.' });
  } catch (error) {
    console.error('Error al actualizar servicio:', error);
    res.status(500).json({ error: 'No se pudo actualizar el servicio.' });
  }
});

app.delete('/api/servicios/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE servicios_catalogo SET activo = 0 WHERE id = ?', [id]);
    res.json({ mensaje: 'Servicio eliminado del catálogo.' });
  } catch (error) {
    console.error('Error al eliminar servicio:', error);
    res.status(500).json({ error: 'No se pudo eliminar el servicio.' });
  }
});

// ==========================================
// RUTAS PROTEGIDAS: COTIZACIONES
// ==========================================

app.get('/api/cotizaciones', verificarToken, async (req, res) => {
  try {
    const [cotizaciones] = await pool.query(
      `SELECT c.*, u.nombre AS creado_por
       FROM cotizaciones c
       LEFT JOIN usuarios u ON c.usuario_id = u.id
       ORDER BY c.id DESC`
    );
    const [items] = await pool.query('SELECT * FROM cotizacion_items');

    const resultado = cotizaciones.map((cot) => ({
      ...cot,
      items: items.filter((item) => item.cotizacion_id === cot.id)
    }));

    res.json(resultado);
  } catch (error) {
    console.error('Error al consultar cotizaciones:', error);
    res.status(500).json({ error: 'Error al obtener las cotizaciones de MySQL' });
  }
});

app.post('/api/cotizaciones', verificarToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const {
      cliente_nombre,
      cliente_empresa,
      cliente_email,
      cliente_telefono,
      fecha_emision,
      fecha_vencimiento,
      aplicar_iva,
      subtotal,
      iva,
      total,
      notas,
      items
    } = req.body;

    if (!cliente_nombre || !cliente_email || !items || items.length === 0) {
      return res.status(400).json({ error: 'Faltan datos obligatorios del cliente o conceptos.' });
    }

    await connection.beginTransaction();

    const [rows] = await connection.query('SELECT MAX(id) AS maxId FROM cotizaciones');
    const siguienteNumero = (rows[0].maxId || 0) + 1;
    const anio = new Date().getFullYear();
    const folio = `NWD-${anio}-${String(siguienteNumero).padStart(4, '0')}`;

    const [result] = await connection.query(
      `INSERT INTO cotizaciones (
        folio, usuario_id, cliente_nombre, cliente_empresa, cliente_email, cliente_telefono,
        fecha_emision, fecha_vencimiento, aplicar_iva, subtotal, iva, total, notas, estado
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'borrador')`,
      [
        folio,
        req.usuario.id,
        cliente_nombre,
        cliente_empresa || null,
        cliente_email,
        cliente_telefono,
        fecha_emision,
        fecha_vencimiento,
        aplicar_iva ? 1 : 0,
        subtotal,
        iva,
        total,
        notas || null
      ]
    );

    const cotizacionId = result.insertId;

    for (const item of items) {
      const importe = Number(item.cantidad) * Number(item.precio_unitario);
      await connection.query(
        `INSERT INTO cotizacion_items (
          cotizacion_id, descripcion, detalle, cantidad, precio_unitario, importe
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          cotizacionId,
          item.descripcion,
          item.detalle || null,
          Number(item.cantidad),
          Number(item.precio_unitario),
          importe
        ]
      );
    }

    await connection.commit();

    res.status(201).json({
      mensaje: 'Cotización guardada correctamente',
      id: cotizacionId,
      folio
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error al guardar cotización:', error);
    res.status(500).json({ error: 'No se pudo guardar la cotización en MySQL' });
  } finally {
    connection.release();
  }
});

app.post('/api/cotizaciones/generar-pdf', verificarToken, async (req, res) => {
  try {
    const pdfBuffer = await generarCotizacionPDF(req.body);
    const folio = (req.body.folio || 'Cotizacion-Nativo').replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${folio}.pdf"`);
    res.setHeader('X-PDF-Url', `${req.protocol}://${req.get('host')}/pdfs/${folio}.pdf`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error al generar PDF:', error);
    res.status(500).json({ error: 'Error al generar el archivo PDF.' });
  }
});

app.post('/api/cotizaciones/enviar-correo', verificarToken, async (req, res) => {
  try {
    const datos = req.body;
    const {
      id,
      folio,
      cliente_nombre,
      cliente_empresa,
      cliente_email,
      fecha_emision,
      fecha_vencimiento,
      aplicar_iva,
      subtotal,
      iva,
      total,
      notas,
      items
    } = datos;

    if (!cliente_email) {
      return res.status(400).json({ error: 'El correo del cliente es requerido.' });
    }

    const pdfBuffer = await generarCotizacionPDF(datos);

    const formatoMoneda = (valor) =>
      new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(valor || 0));

    const filasHtml = items
      .map(
        (item) => `
        <tr>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">
            <strong style="color: #141414;">${item.descripcion}</strong>
            ${item.detalle ? `<div style="font-size: 12px; color: #6b7280; margin-top: 4px;">${item.detalle}</div>` : ''}
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">${item.cantidad}</td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatoMoneda(item.precio_unitario)}</td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right; font-weight: 600;">${formatoMoneda(item.cantidad * item.precio_unitario)}</td>
        </tr>`
      )
      .join('');

    const htmlCorreo = `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 680px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
        <div style="background: #0a0a0a; color: #ffffff; padding: 28px 32px; border-bottom: 4px solid #b86b35;">
          <h1 style="margin: 0; font-size: 26px; letter-spacing: 4px; font-weight: 800;">
            N<span style="color: #b86b35;">A</span>TIVO
          </h1>
          <p style="margin: 4px 0 0; font-family: monospace; color: #9ca3af; font-size: 13px; letter-spacing: 2px;">
            { WEB, DESIGN; }
          </p>
        </div>

        <div style="padding: 28px 32px;">
          <p style="font-size: 14px; color: #374151; margin-top: 0;">
            Hola <strong>${cliente_nombre}</strong>, adjuntamos en formato PDF y detallamos a continuación tu cotización solicitada:
          </p>

          <div style="display: flex; justify-content: space-between; margin: 20px 0 24px; background: #f9fafb; padding: 14px; border-radius: 6px;">
            <div>
              <p style="margin: 0; font-size: 11px; text-transform: uppercase; color: #6b7280;">Cliente</p>
              <h2 style="margin: 4px 0; font-size: 16px; color: #141414;">${cliente_nombre}</h2>
              ${cliente_empresa ? `<p style="margin: 0; color: #4b5563; font-size: 13px;">${cliente_empresa}</p>` : ''}
            </div>
            <div style="text-align: right;">
              <p style="margin: 0; font-weight: 700; color: #b86b35; font-size: 15px;">${folio || 'COTIZACIÓN'}</p>
              <p style="margin: 4px 0 0; font-size: 12px; color: #4b5563;">Emisión: ${fecha_emision}</p>
              <p style="margin: 2px 0 0; font-size: 12px; color: #4b5563;">Válida hasta: ${fecha_vencimiento}</p>
            </div>
          </div>

          <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 24px;">
            <thead>
              <tr style="background: #f3f4f6; color: #1f2937; text-align: left;">
                <th style="padding: 10px 12px;">Concepto</th>
                <th style="padding: 10px 12px; text-align: center;">Cant.</th>
                <th style="padding: 10px 12px; text-align: right;">P. Unitario</th>
                <th style="padding: 10px 12px; text-align: right;">Importe</th>
              </tr>
            </thead>
            <tbody>
              ${filasHtml}
            </tbody>
          </table>

          <div style="width: 260px; margin-left: auto; font-size: 14px;">
            <div style="display: flex; justify-content: space-between; padding: 6px 0; color: #4b5563;">
              <span>Subtotal:</span>
              <span>${formatoMoneda(subtotal)}</span>
            </div>
            ${
              aplicar_iva
                ? `<div style="display: flex; justify-content: space-between; padding: 6px 0; color: #4b5563;">
                    <span>IVA (16%):</span>
                    <span>${formatoMoneda(iva)}</span>
                  </div>`
                : ''
            }
            <div style="display: flex; justify-content: space-between; padding: 10px 0; border-top: 2px solid #141414; font-weight: 700; font-size: 16px; color: #141414;">
              <span>Total MXN:</span>
              <span style="color: #b86b35;">${formatoMoneda(total)}</span>
            </div>
          </div>

          ${
            notas
              ? `<div style="margin-top: 24px; padding: 14px; background: #f9fafb; border-left: 3px solid #b86b35; font-size: 13px; color: #374151;">
                  <strong>Condiciones y Notas:</strong><br/>${notas}
                </div>`
              : ''
          }
        </div>

        <div style="background: #f3f4f6; padding: 16px 32px; text-align: center; font-size: 12px; color: #6b7280;">
          Nativo Web Design • Soluciones Digitales y Desarrollo Web • Tel: ${process.env.EMPRESA_TELEFONO || '9142790344'}
        </div>
      </div>
    `;

    await transporter.sendMail({
      from: `"Nativo Web Design" <${process.env.SMTP_USER}>`,
      to: cliente_email,
      subject: `Cotización ${folio || ''} - Nativo Web Design`,
      html: htmlCorreo,
      attachments: [
        {
          filename: `Cotizacion-${folio || 'NativoWebDesign'}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf'
        }
      ]
    });

    if (id) {
      await pool.query("UPDATE cotizaciones SET estado = 'enviada' WHERE id = ?", [id]);
    }

    res.json({ mensaje: `Correo con PDF adjunto enviado exitosamente a ${cliente_email}` });
  } catch (error) {
    console.error('Error al enviar correo:', error);
    res.status(500).json({ error: 'Error al enviar el correo electrónico. Verifica tu configuración SMTP en backend/.env.' });
  }
});

app.patch('/api/cotizaciones/:id/estado', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { estado } = req.body;
    await pool.query('UPDATE cotizaciones SET estado = ? WHERE id = ?', [estado, id]);
    res.json({ mensaje: 'Estado actualizado' });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar estado' });
  }
});

app.delete('/api/cotizaciones/:id', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM cotizaciones WHERE id = ?', [id]);
    res.json({ mensaje: 'Cotización eliminada' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar la cotización' });
  }
});

const PORT = process.env.PORT || 4000;
inicializarAutenticacion().then(() => {
  app.listen(PORT, () => {
    console.log(`Servidor de Nativo Web Design corriendo en http://localhost:${PORT}`);
  });
});
