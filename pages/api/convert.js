import formidable from 'formidable'
import fs from 'fs'
import { XMLParser, XMLBuilder } from 'fast-xml-parser'

export const config = { api: { bodyParser: false } }

const OLD_NS = "urn:iso:std:iso:20022:tech:xsd:camt.053.001.04"
const NEW_NS = "urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"
const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance"

const STMT_ORDER = ['Id','ElctrncSeqNb','CreDtTm','FrToDt','CpyDplctInd','Acct']
const STMT_MULTI = ['Bal','Ntry']
const NTRY_ORDER = ['NtryRef','Amt','CdtDbtInd','RvslInd','Sts','BookgDt','ValDt','AcctSvcrRef','BkTxCd','NtryDtls','AddtlNtryInf']
const TX_ORDER = ['Refs','Amt','CdtDbtInd','AmtDtls','BkTxCd','RltdPties','RltdAgts','RmtInf']

function ensureArray(value) {
  if (Array.isArray(value)) return value
  if (value != null) return [value]
  return []
}

function reorderObject(obj, order, multi = []) {
  const result = {}
  
  // Erst die geordneten Felder
  order.forEach(key => {
    if (obj[key] !== undefined) {
      result[key] = obj[key]
    }
  })
  
  // Dann die Multi-Felder
  multi.forEach(key => {
    if (obj[key] !== undefined) {
      result[key] = obj[key]
    }
  })
  
  // Alle anderen Felder
  Object.keys(obj).forEach(key => {
    if (!order.includes(key) && !multi.includes(key)) {
      result[key] = obj[key]
    }
  })
  
  return result
}

export default async function handler(req, res) {
  try {
    const form = new formidable.IncomingForm()
    
    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) =>
        err ? reject(err) : resolve({ fields, files })
      )
    })

    if (!files.file) {
      return res.status(400).send('No file uploaded')
    }

    const xml = fs.readFileSync(files.file.filepath, 'utf8')
    
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@',
      textNodeName: '#text',
      preserveOrder: false
    })

    const jsonObj = parser.parse(xml)
    
    // GrpHdr AddtlInf als Standard-Beschreibung
    const grpText = jsonObj?.Document?.BkToCstmrStmt?.GrpHdr?.AddtlInf || ''
    
    // Namespace aktualisieren
    jsonObj.Document['@xmlns'] = NEW_NS
    jsonObj.Document['@xmlns:xsi'] = XSI_NS
    jsonObj.Document['@xsi:schemaLocation'] = `${NEW_NS} camt.053.001.08.xsd`
    
    // Stmt reorganisieren
    const stmt = jsonObj.Document.BkToCstmrStmt.Stmt
    const reorderedStmt = reorderObject(stmt, STMT_ORDER, STMT_MULTI)
    
    // Ntry-Einträge verarbeiten
    const entries = ensureArray(reorderedStmt.Ntry)
    reorderedStmt.Ntry = entries.map(entry => {
      const reorderedEntry = reorderObject(entry, NTRY_ORDER)
      
      // TxDtls verarbeiten
      if (reorderedEntry.NtryDtls?.TxDtls) {
        const txDtls = reorderedEntry.NtryDtls.TxDtls
        const reorderedTx = reorderObject(txDtls, TX_ORDER)
        
        // AmtDtls hinzufügen falls fehlt
        if (!reorderedTx.AmtDtls && reorderedTx.Amt) {
          reorderedTx.AmtDtls = {
            InstdAmt: {
              '@Ccy': reorderedTx.Amt['@Ccy'],
              '#text': reorderedTx.Amt['#text']
            }
          }
        }
        
        // RltdPties korrigieren
        if (reorderedTx.RltdPties) {
          const rltdPties = reorderedTx.RltdPties
          
          // DbtrAcct zu CdtrAcct umbenennen
          if (rltdPties.DbtrAcct) {
            rltdPties.CdtrAcct = rltdPties.DbtrAcct
            delete rltdPties.DbtrAcct
          }
          
          // Cdtr mit Pty wrapper
          if (rltdPties.Cdtr && !rltdPties.Cdtr.Pty) {
            const cdtrContent = { ...rltdPties.Cdtr }
            rltdPties.Cdtr = { Pty: cdtrContent }
          }
        }
        
        // RmtInf korrigieren
        if (!reorderedTx.RmtInf) {
          reorderedTx.RmtInf = { Ustrd: [grpText] }
        } else if (reorderedTx.RmtInf.Ustrd) {
          const ustrdArray = ensureArray(reorderedTx.RmtInf.Ustrd)
          if (!ustrdArray.includes(grpText)) {
            ustrdArray.push(grpText)
          }
          reorderedTx.RmtInf.Ustrd = ustrdArray
        }
        
        // RltdAgts hinzufügen falls fehlt
        if (!reorderedTx.RltdAgts) {
          reorderedTx.RltdAgts = null
        }
        
        reorderedEntry.NtryDtls.TxDtls = reorderedTx
      }
      
      // AddtlNtryInf hinzufügen falls fehlt
      if (!reorderedEntry.AddtlNtryInf) {
        reorderedEntry.AddtlNtryInf = grpText
      }
      
      return reorderedEntry
    })
    
    jsonObj.Document.BkToCstmrStmt.Stmt = reorderedStmt
    
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: '@',
      textNodeName: '#text',
      format: true,
      indentBy: '  ',
      suppressEmptyNode: false
    })

    const xmlOutput = builder.build(jsonObj)
    
    // Nur EINE XML-Deklaration
    const finalXml = `<?xml version='1.0' encoding='UTF-8'?>\n${xmlOutput}`

    res.setHeader('Content-Type', 'application/xml')
    res.setHeader('Content-Disposition', 'attachment; filename="converted.xml"')
    res.status(200).send(finalXml)

  } catch (error) {
    console.error('Conversion error:', error)
    res.status(500).send('Conversion failed: ' + error.message)
  }
}
