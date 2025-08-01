// convert.js
// Konvertiert camt.053.001.04 zu camt.053.001.08 mit korrekter Struktur

const fs = require('fs');
const { DOMParser, XMLSerializer } = require('xmldom');
const xpath = require('xpath');

const OLD_NS = 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.04';
const NEW_NS = 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.08';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';

function convert(inputXml) {
  const doc = new DOMParser().parseFromString(inputXml, 'text/xml');
  const select = xpath.useNamespaces({ ns: OLD_NS });

  // Namespace-Update
  const document = doc.documentElement;
  document.setAttribute('xmlns', NEW_NS);
  document.setAttribute('xmlns:xsi', XSI_NS);
  document.setAttributeNS(XSI_NS, 'xsi:schemaLocation', `${NEW_NS} camt.053.001.08.xsd`);

  // Konvertiere <Amt>
  const amts = select('//ns:Amt', doc);
  for (const amt of amts) {
    const currency = select('./ns:Ccy', amt)[0];
    if (currency) {
      amt.setAttribute('Ccy', currency.textContent);
      amt.textContent = amt.textContent.replace(currency.textContent, '').trim();
      amt.removeChild(currency);
    }
  }

  // Konvertiere <RltdPties>
  const rltdPtiesNodes = select('//ns:NtryDtls/ns:TxDtls/ns:RltdPties', doc);
  for (const oldRltdPties of rltdPtiesNodes) {
    const newRltdPties = doc.createElementNS(NEW_NS, 'RltdPties');

    // Hole ursprünglichen Namen und Adresse
    const name = select('.//ns:Nm', oldRltdPties)[0]?.textContent || 'Unbekannt';
    const adrLine = select('.//ns:AdrLine', oldRltdPties)[0]?.textContent || 'Unbekannt';
    const iban = select('.//ns:IBAN', oldRltdPties)[0]?.textContent || 'CH0000000000000000000';

    const cdtr = doc.createElementNS(NEW_NS, 'Cdtr');
    const pty = doc.createElementNS(NEW_NS, 'Pty');
    const nm = doc.createElementNS(NEW_NS, 'Nm');
    nm.textContent = name;
    const pstlAdr = doc.createElementNS(NEW_NS, 'PstlAdr');
    const adr = doc.createElementNS(NEW_NS, 'AdrLine');
    adr.textContent = adrLine;
    pstlAdr.appendChild(adr);
    pty.appendChild(nm);
    pty.appendChild(pstlAdr);
    cdtr.appendChild(pty);

    const cdtrAcct = doc.createElementNS(NEW_NS, 'CdtrAcct');
    const id = doc.createElementNS(NEW_NS, 'Id');
    const ibanEl = doc.createElementNS(NEW_NS, 'IBAN');
    ibanEl.textContent = iban;
    id.appendChild(ibanEl);
    cdtrAcct.appendChild(id);

    newRltdPties.appendChild(cdtr);
    newRltdPties.appendChild(cdtrAcct);

    oldRltdPties.parentNode.replaceChild(newRltdPties, oldRltdPties);
  }

  // <RltdAgts /> statt leerem Element
  const rltdAgtsNodes = select('//ns:NtryDtls/ns:TxDtls/ns:RltdAgts', doc);
  for (const node of rltdAgtsNodes) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  return new XMLSerializer().serializeToString(doc);
}

// Beispielnutzung
const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) {
  console.error('Usage: node convert.js input.xml output.xml');
  process.exit(1);
}

const inputXml = fs.readFileSync(inputPath, 'utf-8');
const outputXml = convert(inputXml);
fs.writeFileSync(outputPath, outputXml);
console.log(`Konvertierung abgeschlossen: ${outputPath}`);
