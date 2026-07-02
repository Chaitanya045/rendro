import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT || "http://127.0.0.1:9000",
  region: process.env.MINIO_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY || "minioadmin",
    secretAccessKey: process.env.MINIO_SECRET_KEY || "minioadmin",
  },
  forcePathStyle: true,
});

const ORG = "gmail";
const TOTAL = 1000;
const BATCH = 25;

const folders = [
  "api/v1", "api/v2", "api/v2/auth", "api/v2/endpoints",
  "guides/auth", "guides/rate-limiting", "guides/webhooks", "guides/errors",
  "architecture/overview", "architecture/data-flow", "architecture/storage", "architecture/networking",
  "reference/sdk", "reference/cli", "reference/config",
  "onboarding", "tutorials/basics", "tutorials/advanced",
  "changelog", "faq", "migration/v1-to-v2", "migration/v2-to-v3",
];

console.log(`Uploading ${TOTAL} docs to ${ORG}/...`);

let done = 0;

for (let i = 0; i < TOTAL; i += BATCH) {
  const batch = [];
  for (let j = i; j < Math.min(i + BATCH, TOTAL); j++) {
    const folder = folders[j % folders.length];
    const name = `doc-${String(j + 1).padStart(4, "0")}`;
    const key = `${ORG}/${folder}/${name}.html`;
    const content = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${name} — ${folder}</title><style>body{font-family:Inter,sans-serif;max-width:800px;margin:2rem auto;padding:0 1.5rem;line-height:1.6;color:#1a1a2e}</style></head><body><h1>${name}</h1><p>Location: <code>${folder}</code></p><p>Doc #${j + 1} of ${TOTAL}.</p></body></html>`;
    batch.push(s3.send(new PutObjectCommand({ Bucket: "docs", Key: key, Body: content, ContentType: "text/html" })));
  }
  await Promise.all(batch);
  done += BATCH;
  if (done % 100 === 0) console.log(`  ${done}/${TOTAL}`);
}

console.log(`Done. ${TOTAL} files uploaded.`);