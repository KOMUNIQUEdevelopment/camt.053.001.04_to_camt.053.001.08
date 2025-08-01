import formidable from 'formidable';
import fs from 'fs';
import { create } from 'xmlbuilder2';
import { xml2js } from 'xml-js';

export const config = {
  api: {
    bodyParser: false
  }
};

export default async function handler(req, res) {
  const form = new formidable.IncomingForm();

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).send('Upload-Fehler');

    const file = files.file[0];
    const xml = fs.readFileSync(file.filepath, 'utf8');
    const json = xml2js(xml, { compact: false, spaces: 2 });

    json._declaration = { _attributes: { version: '1.0', encoding: 'UTF-8' } };

    const doc = create(json);
    const result = doc.end({ prettyPrint: true });

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', 'attachment; filename="converted.xml"');
    res.status(200).send(result);
  });
}
