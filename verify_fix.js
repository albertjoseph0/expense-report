const crypto = require('crypto');
const path = require('path');

function generateServerFilename(originalname) {
  const unique = crypto.randomUUID();
  return unique + path.extname(originalname);
}

function generateEmailFilename(originalFilename) {
  const ext = path.extname(originalFilename || '.png') || '.png';
  const uniqueName = crypto.randomUUID() + ext;
  return uniqueName;
}

const testFiles = ['receipt.jpg', 'invoice.pdf', 'image.png', 'noext', ''];

console.log('Testing Server Filename Generation:');
testFiles.forEach(f => {
  const generated = generateServerFilename(f);
  console.log(`${f} -> ${generated}`);
  // UUID v4 format is 8-4-4-4-12 hex digits
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]+)?$/i.test(generated)) {
    console.error(`FAILED: ${generated} is not a valid UUID based filename`);
    process.exit(1);
  }
});

console.log('\nTesting Email Filename Generation:');
testFiles.forEach(f => {
  const generated = generateEmailFilename(f);
  console.log(`${f} -> ${generated}`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]+)?$/i.test(generated)) {
    console.error(`FAILED: ${generated} is not a valid UUID based filename`);
    process.exit(1);
  }
});

// Check uniqueness
const uuids = new Set();
for (let i = 0; i < 1000; i++) {
  const u = crypto.randomUUID();
  if (uuids.has(u)) {
    console.error(`FAILED: Duplicate UUID generated: ${u}`);
    process.exit(1);
  }
  uuids.add(u);
}
console.log('\nGenerated 1000 unique UUIDs successfully.');
console.log('\nAll tests passed!');
