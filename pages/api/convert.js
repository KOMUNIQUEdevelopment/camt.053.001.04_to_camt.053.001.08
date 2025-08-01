import formidable from 'formidable'
import fs from 'fs'
import { XMLParser, XMLBuilder } from 'fast-xml-parser'

export const config = { api: { bodyParser: false } }

export default async function handler(req, res) {
  const form = new formidable.IncomingForm()
  const { files } = await new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) =>
      err ? reject(err) : resolve({ fields, files })
    )
  })

  const xml = fs.readFileSync(files.file.filepath || files.file.path, 'utf8')
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' })
  const json = parser.parse(xml)

    // Transformation analog Python-Skript
  const stmtIn = formJson.Document.BkToCstmrStmt.Stmt;
  const grpInf = formJson.Document.BkToCstmrStmt.GrpHdr.AddtlInf;
  const grpText = (typeof grpInf === 'object' ? grpInf['#text'] : grpInf) || '';

  // Helper to ensure array
  const ensureArray = v => Array.isArray(v) ? v : v != null ? [v] : [];

  // Reorder statement fields
  const newStmt = {};
  STMT_ORDER.forEach(key => { if (stmtIn[key] != null) newStmt[key] = stmtIn[key]; });
  STMT_MULTI.forEach(key => { if (stmtIn[key] != null) newStmt[key] = stmtIn[key]; });

  // Process entries
  const oldEntries = ensureArray(stmtIn.Ntry);
  const newEntries = oldEntries.map(oldN => {
    const n = {};
    // Reorder Ntry
    NTRY_ORDER.forEach(tag => {
      if (tag === 'NtryDtls') {
        if (oldN.NtryDtls) n.NtryDtls = oldN.NtryDtls;
      } else if (tag === 'AddtlNtryInf') {
        if (oldN.AddtlNtryInf) {
          n.AddtlNtryInf = oldN.AddtlNtryInf;
        } else {
          // Fallback: Kreditor-Name
          const tx = oldN.NtryDtls && oldN.NtryDtls.TxDtls;
          const nm = tx && tx.RltdPties && tx.RltdPties.Cdtr && tx.RltdPties.Cdtr.Pty && tx.RltdPties.Cdtr.Pty.Nm;
          n.AddtlNtryInf = nm || grpText;
        }
      } else if (oldN[tag] != null) {
        n[tag] = oldN[tag];
      }
    });

    // Transform TxDtls
    if (n.NtryDtls && n.NtryDtls.TxDtls) {
      const txIn = n.NtryDtls.TxDtls;
      const newTx = {};
      TX_ORDER.forEach(tag => {
        if (txIn[tag] != null) {
          newTx[tag] = txIn[tag];
        } else {
          // Fallbacks
          if (tag === 'AmtDtls' && txIn.Amt) {
            newTx.AmtDtls = { InstdAmt: { '#text': txIn.Amt['#text'], 'Ccy': txIn.Amt['Ccy'] } };
          }
          if (tag === 'BkTxCd' && oldN.BkTxCd) {
            newTx.BkTxCd = oldN.BkTxCd;
          }
          if (tag === 'RltdPties' && oldN.RltdPties) {
            newTx.RltdPties = oldN.RltdPties;
          }
          if (tag === 'RltdAgts' && oldN.RltdAgts) {
            newTx.RltdAgts = oldN.RltdAgts;
          }
          if (tag === 'RmtInf') {
            if (oldN.RmtInf) newTx.RmtInf = oldN.RmtInf;
            else newTx.RmtInf = { Ustrd: n.AddtlNtryInf };
          }
        }
      });
      n.NtryDtls.TxDtls = newTx;
    }
    return n;
  });
  newStmt.Ntry = newEntries;

  // Build output JSON
  const outJson = {
    Document: {
      'xmlns': NEW_NS,
      'xmlns:xsi': XSI_NS,
      'xsi:schemaLocation': `${NEW_NS} camt.053.001.08.xsd`,
      BkToCstmrStmt: {
        GrpHdr: formJson.Document.BkToCstmrStmt.GrpHdr,
        Stmt: newStmt
      }
    }
  };

  const builder2 = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '' });
  const outXml = builder2.build(outJson);
  res.setHeader('Content-Type', 'application/xml');
  res.status(200).send(outXml);
}
