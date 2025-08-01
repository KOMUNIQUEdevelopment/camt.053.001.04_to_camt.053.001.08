import { DOMParser, XMLSerializer } from 'xmldom';
import xpath from 'xpath';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  const { xmlString } = req.body;

  if (!xmlString) {
    return res.status(400).json({ error: 'Missing XML input' });
  }

  try {
    const doc = new DOMParser().parseFromString(xmlString, 'text/xml');

    // Root Element Namespace-Update
    doc.documentElement.setAttribute('xmlns', 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.08');

    // Anpassung des Namespace-Präfixes (optional, falls nötig)
    const select = xpath.useNamespaces({ ns: 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.04' });

    // GrpHdr prüfen/umstrukturieren
    const grpHdr = select('//ns:GrpHdr', doc)[0];
    if (!grpHdr) throw new Error('GrpHdr not found');

    // Statement-Elemente durchlaufen
    const statements = select('//ns:Stmt', doc);
    for (const stmt of statements) {
      const entries = select('.//ns:Ntry', stmt);
      for (const entry of entries) {
        const txDtls = select('.//ns:TxDtls', entry);
        for (const tx of txDtls) {
          // <Amt Ccy="CHF"> statt verschachtelt
          const amt = select('./ns:Amt', tx)[0];
          if (amt && amt.firstChild) {
            const currency = amt.getAttribute('Ccy');
            const amount = amt.textContent;
            const newAmt = doc.createElement('Amt');
            newAmt.setAttribute('Ccy', currency || 'CHF');
            newAmt.textContent = amount;
            tx.replaceChild(newAmt, amt);
          }

          // <RltdPties>
          let rltdPties = select('./ns:RltdPties', tx)[0];
          if (rltdPties) {
            tx.removeChild(rltdPties);
          }

          rltdPties = doc.createElement('RltdPties');

          const cdtr = doc.createElement('Cdtr');
          const cdtrNm = doc.createElement('Nm');
          cdtrNm.textContent = 'Unbekannt';
          cdtr.appendChild(cdtrNm);

          const cdtrAcct = doc.createElement('CdtrAcct');
          const id = doc.createElement('Id');
          const iban = doc.createElement('IBAN');
          iban.textContent = 'CH0000000000000000000';
          id.appendChild(iban);
          cdtrAcct.appendChild(id);

          rltdPties.appendChild(cdtr);
          rltdPties.appendChild(cdtrAcct);
          tx.appendChild(rltdPties);
        }
      }
    }

    const output = new XMLSerializer().serializeToString(doc);
    res.status(200).json({ convertedXml: output });
  } catch (error) {
    console.error('Conversion error:', error);
    res.status(500).json({ error: 'Failed to convert XML.' });
  }
}
