import formidable from 'formidable'
import fs from 'fs'
import { XMLParser, XMLBuilder } from 'fast-xml-parser'

export const config = { api: { bodyParser: false } }

export default async function handler(req, res) {
  const form = new formidable.IncomingForm();
  const { fields, files } = await new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => err ? reject(err) : resolve({ fields, files }));
  });
  const path = files.file.filepath || files.file.path;
  let xml;
  try {
    xml = fs.readFileSync(path, 'utf8');
  } catch (e) {
    res.status(400).send('Error reading file'); return;
  }
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
  let json;
  try {
    json = parser.parse(xml);
  } catch (e) {
    res.status(400).send('Error parsing XML'); return;
  }

  // Transformation logic
  try {
    const formJson = json;
    const stmtIn = formJson.Document.BkToCstmrStmt.Stmt;
    const grpInf = formJson.Document.BkToCstmrStmt.GrpHdr.AddtlInf;
    const grpText = (typeof grpInf === 'object' ? grpInf['#text'] || '' : grpInf) || '';

    // reorder statement
    function ensureArray(v) { return Array.isArray(v)? v : v!=null? [v] : []; }
    function reorderObject(obj, order, multi=[]) {
      const out = {};
      order.forEach(k=>{ if(obj[k]!=null) out[k]=obj[k]; });
      multi.forEach(k=>{ if(obj[k]!=null) out[k]=obj[k]; });
      Object.keys(obj).filter(k=>!order.includes(k)&&!multi.includes(k)).forEach(k=>{ out[k]=obj[k]; });
      return out;
    }

    const newStmt = reorderObject(stmtIn, STMT_ORDER, STMT_MULTI);
    const oldEntries = ensureArray(stmtIn.Ntry);
    const newEntries = oldEntries.map(oldN => {
      const n = {};
      NTRY_ORDER.forEach(tag => {
        if(tag === 'NtryDtls') {
          if(oldN.NtryDtls) n.NtryDtls = oldN.NtryDtls;
        } else if(tag === 'AddtlNtryInf') {
          if(oldN.AddtlNtryInf) n.AddtlNtryInf = oldN.AddtlNtryInf;
          else {
            const tx = oldN.NtryDtls?.TxDtls;
            const nm = tx?.RltdPties?.Cdtr?.Pty?.Nm;
            n.AddtlNtryInf = nm || grpText;
          }
        } else if(oldN[tag]!=null) {
          n[tag] = oldN[tag];
        }
      });
      if(n.NtryDtls?.TxDtls) {
        const txIn = n.NtryDtls.TxDtls;
        const newTx = {};
        TX_ORDER.forEach(tag=>{
          if(txIn[tag]!=null) newTx[tag] = txIn[tag];
          else {
            if(tag==='AmtDtls' && txIn.Amt) {
              newTx.AmtDtls = { InstdAmt: { '#text': txIn.Amt['#text'], 'Ccy': txIn.Amt.Ccy } };
            }
            if(tag==='BkTxCd' && oldN.BkTxCd) newTx.BkTxCd = oldN.BkTxCd;
            if(tag==='RltdPties' && oldN.RltdPties) newTx.RltdPties = oldN.RltdPties;
            if(tag==='RltdAgts' && oldN.RltdAgts) newTx.RltdAgts = oldN.RltdAgts;
            if(tag==='RmtInf') {
              if(oldN.RmtInf) newTx.RmtInf = oldN.RmtInf;
              else newTx.RmtInf = { Ustrd: n.AddtlNtryInf };
            }
          }
        });
        n.NtryDtls.TxDtls = newTx;
      }
      return n;
    });
    newStmt.Ntry = newEntries;

    const outJson = { Document: {
      '@xmlns': NEW_NS,
      '@xmlns:xsi': XSI_NS,
      '@xsi:schemaLocation': `${NEW_NS} camt.053.001.08.xsd`,
      BkToCstmrStmt: {
        GrpHdr: formJson.Document.BkToCstmrStmt.GrpHdr,
        Stmt: newStmt
      }
    } };

    const builder2 = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '' });
    const outXml = builder2.build(outJson);
    res.setHeader('Content-Type', 'application/xml');
    res.status(200).send(outXml);
  } catch(e) {
    console.error(e);
    res.status(500).send('Server error');
  }
}
