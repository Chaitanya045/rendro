/**
 * Initialize MinIO: create bucket and seed with sample docs.
 * Run: bun run scripts/init-minio.ts
 */
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT ?? "http://localhost:9000",
  region: process.env.MINIO_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY ?? "minioadmin",
    secretAccessKey: process.env.MINIO_SECRET_KEY ?? "minioadmin",
  },
  forcePathStyle: true,
});

const BUCKET = process.env.MINIO_BUCKET ?? "docs";

async function main() {
  // Ensure bucket exists
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log(`Bucket "${BUCKET}" already exists.`);
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    console.log(`Created bucket "${BUCKET}".`);
  }

  const sampleDocs: Record<string, string> = {
    "acme-corp/index.html": `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Acme Corp — Home</title>
<style>body{font-family:system-ui,sans-serif;max-width:700px;margin:2rem auto;padding:0 1rem;line-height:1.6}</style>
</head>
<body>
<h1>Welcome to Acme Corp Docs</h1>
<p>This is the home page for Acme Corporation documentation.</p>
<ul>
  <li><a href="/acme-corp/onboarding/index.html">Onboarding Guide</a></li>
  <li><a href="/acme-corp/api/index.html">API Reference</a></li>
</ul>
</body>
</html>`,

    "acme-corp/onboarding/index.html": `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Onboarding Guide</title>
<style>body{font-family:system-ui,sans-serif;max-width:700px;margin:2rem auto;padding:0 1rem;line-height:1.6}</style>
</head>
<body>
<h1>Onboarding Guide</h1>
<h2>Day 1</h2>
<p>Welcome to Acme Corp! Here's what you need to know on your first day.</p>
<ol>
  <li>Set up your development environment</li>
  <li>Meet your team</li>
  <li>Read the employee handbook</li>
</ol>
<h2>Tools</h2>
<ul>
  <li>Slack — team communication</li>
  <li>GitHub — source control</li>
  <li>Linear — project tracking</li>
</ul>
</body>
</html>`,

    "acme-corp/api/index.html": `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>API Reference</title>
<style>body{font-family:system-ui,sans-serif;max-width:700px;margin:2rem auto;padding:0 1rem;line-height:1.6}pre{background:#f5f5f5;padding:1rem;border-radius:6px;overflow-x:auto}</style>
</head>
<body>
<h1>API Reference</h1>
<h2>Authentication</h2>
<p>All API requests require a Bearer token in the Authorization header.</p>
<pre><code>GET /api/v1/users
Authorization: Bearer &lt;token&gt;</code></pre>
<h2>Endpoints</h2>
<h3>GET /api/v1/users</h3>
<p>Returns a paginated list of users.</p>
<pre><code>curl https://api.acmecorp.com/v1/users \\
  -H "Authorization: Bearer $TOKEN"</code></pre>
</body>
</html>`,

    "startup-io/handbook.html": `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Handbook — Startup.io</title>
<style>body{font-family:system-ui,sans-serif;max-width:700px;margin:2rem auto;padding:0 1rem;line-height:1.6}blockquote{padding:0.5rem 1rem;border-left:3px solid #2563eb;background:#f0f4ff;margin:1rem 0}</style>
</head>
<body>
<h1>Startup.io Handbook</h1>
<blockquote>Move fast, document everything.</blockquote>
<h2>Values</h2>
<ul>
  <li><strong>Transparency</strong> — default to open</li>
  <li><strong>Ownership</strong> — you build it, you run it</li>
  <li><strong>Speed</strong> — ship incrementally</li>
</ul>
<h2>Process</h2>
<p>We work in 2-week cycles. Every cycle starts with planning and ends with a demo.</p>
</body>
</html>`,
  };

  for (const [key, body] of Object.entries(sampleDocs)) {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: "text/html",
      })
    );
    console.log(`  Uploaded: ${key}`);
  }

  console.log(`\nDone! Seeded ${Object.keys(sampleDocs).length} documents.`);
  console.log(`Browse at http://localhost:3000/acme-corp`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
