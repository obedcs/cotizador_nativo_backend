const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const formatoMoneda = (valor) =>
  new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN'
  }).format(Number(valor || 0));

/**
 * Genera un Buffer PDF profesional con el nuevo logotipo oficial de NATIVO { WEB, DESIGN; }
 */
function generarCotizacionPDF(datos) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 45 });
      const chunks = [];

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(chunks);
        try {
          const pdfDir = path.join(__dirname, 'pdfs');
          if (!fs.existsSync(pdfDir)) {
            fs.mkdirSync(pdfDir, { recursive: true });
          }
          const safeFolio = (datos.folio || 'Cotizacion-Nativo').replace(/[^a-zA-Z0-9_-]/g, '_');
          fs.writeFileSync(path.join(pdfDir, `${safeFolio}.pdf`), pdfBuffer);
        } catch (saveErr) {
          console.warn('No se pudo guardar copia local del PDF:', saveErr.message);
        }
        resolve(pdfBuffer);
      });
      doc.on('error', (err) => reject(err));

      const headerBg = '#0a0a0a';
      const brandBlack = '#0f0f0f';
      const brandCopper = '#b86b35';
      const brandGray = '#8e9299';
      const textDark = '#1e293b';
      const textMuted = '#64748b';
      const bgLight = '#f8fafc';

      // Encabezado oscuro para destacar el logotipo blanco + diamante cobre
      doc.rect(0, 0, doc.page.width, 118).fill(headerBg);
      doc.rect(0, 118, doc.page.width, 4).fill(brandCopper);

      // Incrustar nuevo logotipo transparente PNG de Nativo
      const logoPath = path.join(__dirname, 'assets', 'logo-nativo.png');
      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, 42, 18, {
          fit: [265, 82],
          align: 'left',
          valign: 'center'
        });
      } else {
        doc
          .fillColor('#ffffff')
          .font('Helvetica-Bold')
          .fontSize(26)
          .text('NATIVO', 45, 32, { characterSpacing: 4 });
        doc
          .fillColor(brandGray)
          .font('Courier-Bold')
          .fontSize(11)
          .text('{ WEB, DESIGN; }', 47, 66, { characterSpacing: 3 });
      }

      // Metadatos de cotización a la derecha
      doc
        .fillColor(brandCopper)
        .font('Helvetica-Bold')
        .fontSize(10)
        .text('COTIZACIÓN', 380, 28, { align: 'right', width: 185 });

      doc
        .fillColor('#ffffff')
        .font('Helvetica-Bold')
        .fontSize(13)
        .text(datos.folio || 'BORRADOR', 380, 44, { align: 'right', width: 185 });

      doc
        .fillColor('#d1d5db')
        .font('Helvetica')
        .fontSize(9.5)
        .text(`Emisión: ${datos.fecha_emision}`, 380, 65, { align: 'right', width: 185 })
        .text(`Vigencia: ${datos.fecha_vencimiento}`, 380, 80, { align: 'right', width: 185 });

      // Bloque de datos del cliente
      let y = 140;
      doc.roundedRect(45, y, 522, 68, 6).fill(bgLight);

      doc
        .fillColor(brandCopper)
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .text('PREPARADO PARA:', 60, y + 12);

      doc
        .fillColor(brandBlack)
        .font('Helvetica-Bold')
        .fontSize(12)
        .text(datos.cliente_nombre || 'Cliente', 60, y + 26);

      if (datos.cliente_empresa) {
        doc
          .fillColor(textMuted)
          .font('Helvetica')
          .fontSize(9.5)
          .text(datos.cliente_empresa, 60, y + 43);
      }

      doc
        .fillColor(textMuted)
        .font('Helvetica')
        .fontSize(9.5)
        .text(datos.cliente_email || '', 330, y + 26, { align: 'right', width: 222 })
        .text(`Tel: ${datos.cliente_telefono || '—'}`, 330, y + 42, { align: 'right', width: 222 });

      // Tabla de conceptos
      y += 88;
      doc.rect(45, y, 522, 26).fill('#f1f5f9');
      doc
        .fillColor(textMuted)
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .text('DESCRIPCIÓN', 55, y + 8)
        .text('CANT.', 335, y + 8, { width: 45, align: 'center' })
        .text('P. UNITARIO', 385, y + 8, { width: 85, align: 'right' })
        .text('IMPORTE', 475, y + 8, { width: 82, align: 'right' });

      y += 32;

      const items = datos.items || [];
      for (const item of items) {
        const descHeight = doc.heightOfString(item.descripcion || '', { width: 265 });
        const detHeight = item.detalle
          ? doc.heightOfString(item.detalle, { width: 265, size: 8.5 })
          : 0;
        const rowHeight = Math.max(26, descHeight + detHeight + 14);

        if (y + rowHeight > doc.page.height - 150) {
          doc.addPage();
          y = 50;
        }

        doc
          .fillColor(textDark)
          .font('Helvetica-Bold')
          .fontSize(9.5)
          .text(item.descripcion || '', 55, y, { width: 265 });

        if (item.detalle) {
          doc
            .fillColor(textMuted)
            .font('Helvetica')
            .fontSize(8.5)
            .text(item.detalle, 55, y + descHeight + 3, { width: 265 });
        }

        const importe = Number(item.cantidad || 0) * Number(item.precio_unitario || 0);

        doc
          .fillColor(textDark)
          .font('Helvetica')
          .fontSize(9.5)
          .text(String(item.cantidad), 335, y, { width: 45, align: 'center' })
          .text(formatoMoneda(item.precio_unitario), 385, y, { width: 85, align: 'right' })
          .font('Helvetica-Bold')
          .text(formatoMoneda(importe), 475, y, { width: 82, align: 'right' });

        y += rowHeight;
        doc
          .moveTo(45, y - 4)
          .lineTo(567, y - 4)
          .strokeColor('#e2e8f0')
          .lineWidth(0.75)
          .stroke();
      }

      // Totales
      y += 14;
      if (y > doc.page.height - 160) {
        doc.addPage();
        y = 50;
      }

      doc
        .fillColor(textMuted)
        .font('Helvetica')
        .fontSize(10)
        .text('Subtotal:', 370, y, { width: 95, align: 'right' })
        .fillColor(textDark)
        .text(formatoMoneda(datos.subtotal), 470, y, { width: 87, align: 'right' });

      y += 20;

      if (datos.aplicar_iva) {
        doc
          .fillColor(textMuted)
          .font('Helvetica')
          .fontSize(10)
          .text('IVA (16%):', 370, y, { width: 95, align: 'right' })
          .fillColor(textDark)
          .text(formatoMoneda(datos.iva), 470, y, { width: 87, align: 'right' });
        y += 20;
      }

      doc
        .moveTo(370, y)
        .lineTo(567, y)
        .strokeColor(brandBlack)
        .lineWidth(1.5)
        .stroke();

      y += 8;
      doc
        .fillColor(brandBlack)
        .font('Helvetica-Bold')
        .fontSize(12)
        .text('TOTAL MXN:', 355, y, { width: 110, align: 'right' })
        .fillColor(brandCopper)
        .text(formatoMoneda(datos.total), 470, y, { width: 87, align: 'right' });

      // Notas y condiciones
      if (datos.notas) {
        y += 42;
        const notesHeight = doc.heightOfString(datos.notas, { width: 490 }) + 28;
        doc.rect(45, y, 522, notesHeight).fill(bgLight);
        doc.rect(45, y, 3, notesHeight).fill(brandCopper);

        doc
          .fillColor(brandBlack)
          .font('Helvetica-Bold')
          .fontSize(9)
          .text('Condiciones y Observaciones:', 58, y + 8);

        doc
          .fillColor(textMuted)
          .font('Helvetica')
          .fontSize(8.8)
          .text(datos.notas, 58, y + 22, { width: 495 });
      }

      // Pie de página
      const footerY = doc.page.height - 45;
      doc
        .fillColor(textMuted)
        .font('Helvetica')
        .fontSize(8.5)
        .text(
          `Nativo Web Design • Desarrollo Web, Sistemas a Medida y Diseño Digital • Tel: ${process.env.EMPRESA_TELEFONO || '9142790344'}`,
          45,
          footerY,
          { align: 'center', width: 522 }
        );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generarCotizacionPDF };
