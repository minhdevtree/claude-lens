// osascript -l JavaScript pdfpage.js <pdf> <page> <px> <out.png>
// Renders one PDF page to PNG with macOS's own PDFKit (no install). Prints the page count; exits 1 past the last page.
ObjC.import('PDFKit')
ObjC.import('AppKit')
function run(argv) {
  const [input, pageNo, px, out] = argv
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(input))
  if (doc.isNil()) throw new Error('cannot open ' + input)
  const index = Number(pageNo) - 1
  if (index < 0 || index >= doc.pageCount) throw new Error('no page ' + pageNo + ' of ' + doc.pageCount)
  const page = doc.pageAtIndex(index)
  const box = page.boundsForBox($.kPDFDisplayBoxMediaBox).size
  const scale = Number(px) / Math.max(box.width, box.height)
  const size = $.NSMakeSize(Math.round(box.width * scale), Math.round(box.height * scale))
  const image = page.thumbnailOfSizeForBox(size, $.kPDFDisplayBoxMediaBox)
  const rep = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation)
  rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically(out, true)
  return String(doc.pageCount)
}
