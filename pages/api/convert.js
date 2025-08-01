import formidable from 'formidable'
import fs from 'fs'
import { XMLParser } from 'fast-xml-parser'

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

function xmlEscape(str) {
  if (typeof str !== 'string') return str
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;')
}

function buildElement(name, obj, indent = 0) {
  const spaces = '  '.repeat(indent)
  
  if (typeof obj === 'string' || typeof obj === 'number') {
    return `${spaces}<${name}>${xmlEscape(String(obj))}</${name}>`
  }
  
  if (obj === null || obj === undefined) {
    return `${spaces}<${name}/>`
  }
  
  let attributes = ''
  let content = []
  
  // Handle attributes and content
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('@')) {
      // Attribute
      const attrName = key.substring(1)
      attributes += ` ${attrName}="${xmlEscape(String(value))}"`
    } else if (key === '#text') {
      // Text content
      return `${spaces}<${name}${attributes}>${xmlEscape(String(value))}</${name}>`
    } else {
      // Child elements
      const children = ensureArray(value)
      for (const child of children) {
        content.push(buildElement(key, child, indent + 1))
      }
    }
  }
  
  if (content.length === 0) {
    return `${spaces}<${name}${attributes}/>`
  }
  
  return [
    `${spaces}<${name}${attributes}>`,
    ...content,
    `${spaces}</${name}>`
  ].join('\n')
}

function copyWithNamespace(obj, sourceNs, targetNs) {
  if (typeof obj !== 'object' || obj === null) return obj
  
  const result = {}
  
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      result[key] = value.map(item => copyWithNamespace(item, sourceNs, targetNs))
    } else if (typeof value === 'object' && value !== null) {
      result[key] = copyWithNamespace(value, sourceNs, targetNs)
    } else {
      result[key] = value
    }
  }
  
  return result
}

function reorderObject(obj, order, multiFields = []) {
  const result = {}
  const allFields = [...order, ...multiFields]
  
  // Add ordered fields first
  for (const field of order) {
    if (obj[field] !== undefined) {
      result[field] = obj[field]
    }
  }
  
  // Add multi fields
  for (const field of multiFields) {
    if (obj[field] !== undefined) {
      result[field] = obj[field]
    }
  }
  
  // Add remaining fields
  for (const [key, value] of Object.entries(obj)) {
    if (!allFields.includes(key)) {
      result[key] = value
    }
  }
  
  return result
}

function transformRltdPties(oldRltdPties) {
  if (!oldRltdPties) return null
  
  const result = {}
  
  // Transform Dbtr -> Cdtr
  if (oldRltdPties.Dbtr) {
    result.Cdtr = {
      Pty: oldRltdPties.Dbtr
    }
  }
  
  // Transform DbtrAcct -> CdtrAcct  
  if (oldRltdPties.DbtrAcct) {
    result.CdtrAcct = oldRltdPties.DbtrAcct
  }
  
  // Keep existing Cdtr/CdtrAcct
  if (oldRltdPties.Cdtr) {
    result.Cdtr = oldRltdPties.Cdtr
  }
  if (oldRltdPties.CdtrAcct) {
    result.CdtrAcct = oldRltdPties.CdtrAcct
  }
  
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

    const json = parser.parse(xml)
    
    // Get group header info for default description
    const grpText = json?.Document?.BkToCstmrStmt?.GrpHdr?.AddtlInf || ''
    
    // Copy and transform structure
    const oldStmt = json.Document.BkToCstmrStmt
    const newDoc = {
      Document: {
        '@xmlns': NEW_NS,
        '@xmlns:xsi': XSI_NS,
        '@xsi:schemaLocation': `${NEW_NS} camt.053.001.08.xsd`,
        BkToCstmrStmt: {
          GrpHdr: copyWithNamespace(oldStmt.GrpHdr, OLD_NS, NEW_NS),
          Stmt: {}
        }
      }
    }
    
    // Process Stmt
    const oldStmtData = oldStmt.Stmt
    const newStmt = reorderObject(oldStmtData, STMT_ORDER, STMT_MULTI)
    
    // Process entries
    if (newStmt.Ntry) {
      const entries = ensureArray(newStmt.Ntry)
      newStmt.Ntry = entries.map(entry => {
        const newEntry = reorderObject(entry, NTRY_ORDER)
        
        // Add AddtlNtryInf if missing
        if (!newEntry.AddtlNtryInf) {
          newEntry.AddtlNtryInf = grpText
        }
        
        // Process TxDtls
        if (newEntry.NtryDtls?.TxDtls) {
          const txDtls = newEntry.NtryDtls.TxDtls
          const newTxDtls = reorderObject(txDtls, TX_ORDER)
          
          // Add AmtDtls if missing
          if (!newTxDtls.AmtDtls && newTxDtls.Amt) {
            newTxDtls.AmtDtls = {
              InstdAmt: {
                '@Ccy': newTxDtls.Amt['@Ccy'],
                '#text': newTxDtls.Amt['#text'] || newTxDtls.Amt
              }
            }
          }
          
          // Transform RltdPties
          if (entry.RltdPties) {
            newTxDtls.RltdPties = transformRltdPties(entry.RltdPties)
          }
          
          // Add empty RltdAgts
          if (!newTxDtls.RltdAgts) {
            newTxDtls.RltdAgts = null
          }
          
          // Add RmtInf
          if (!newTxDtls.RmtInf) {
            newTxDtls.RmtInf = {
              Ustrd: [
                entry.AddtlNtryInf || grpText,
                grpText
              ]
            }
          }
          
          newEntry.NtryDtls.TxDtls = newTxDtls
        }
        
        // Add AmtDtls to entry level
        if (!newEntry.AmtDtls && newEntry.Amt) {
          newEntry.AmtDtls = {
            InstdAmt: {
              Amt: {
                '@Ccy': newEntry.Amt['@Ccy'],
                '#text': newEntry.Amt['#text'] || newEntry.Amt
              }
            }
          }
        }
        
        return newEntry
      })
    }
    
    newDoc.Document.BkToCstmrStmt.Stmt = newStmt
    
    // Build XML manually
    const xmlOutput = [
      "<?xml version='1.0' encoding='UTF-8'?>",
      buildElement('Document', newDoc.Document, 0)
    ].join('\n')
    
    res.setHeader('Content-Type', 'application/xml')
    res.status(200).send(xmlOutput)

  } catch (err) {
    console.error('Error in /api/convert:', err)
    res.status(500).send('Server error: ' + err.message)
  }
}
