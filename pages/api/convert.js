const formidable = require('formidable');
const fs = require('fs');
const xpath = require('xpath');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  const form = new formidable.IncomingForm();

  form.parse(req, async (err, fields, files) => {
    if (err) {
      res.status(500).json({ error: 'Fehler beim Parsen des Formulars' });
      return;
    }

    const file = files.file[0];
    const xmlData = fs.readFileSync(file.filepath, 'utf8');

    const doc = new DOMParser().parseFromString(xmlData, 'application/xml');
    const select = xpath.useNamespaces({
      ns: 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.04',
    });

    const reltdPtiesNodes = select('//ns:RltdPties', doc);
    reltdPtiesNodes.forEach(node => {
      // Entferne bisherige Inhalte
      while (node.firstChild) node.removeChild(node.firstChild);

      // Erstelle neuen Inhalt für <RltdPties>
      const cdtr = doc.createElement('Cdtr');
      const pty = doc.createElement('Pty');
      const nm = doc.createElement('Nm');
      nm.textContent = 'HOSTPOINT AG';

      const pstlAdr = doc.createElement('PstlAdr');
      const adrLine = doc.createElement('AdrLine');
      adrLine.textContent = 'RAPPERSWIL-SG  CHE';

      pstlAdr.appendChild(adrLine);
      pty.appendChild(nm);
      pty.appendChild(pstlAdr);
      cdtr.appendChild(pty);
      node.appendChild(cdtr);

      const cdtrAcct = doc.createElement('CdtrAcct');
      const id = doc.createElement('Id');
      const iban = doc.createElement('IBAN');
      iban.textContent = 'CH7483019KOMUNIQUE000';
      id.appendChild(iban);
      cdtrAcct.appendChild(id);
      node.appendChild(cdtrAcct);
    });

    const outputXml = new XMLSerializer().serializeToString(doc);

    res.setHeader('Content-Type', 'application/xml');
    res.status(200).send(outputXml);
  });
}
