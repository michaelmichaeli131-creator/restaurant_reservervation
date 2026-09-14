# Cloudflare R2 Integration

SpotBook stores restaurant photos in Cloudflare R2 when all required R2 environment variables are configured. If R2 is not configured, the application can fall back to the legacy base64 storage path.

## Environment configuration

Never commit real credentials to Git. Configure these values only in the deployment provider's secret/environment-variable store:

```bash
R2_ACCOUNT_ID=<cloudflare-account-id>
R2_ACCESS_KEY=<r2-access-key-id>
R2_SECRET_KEY=<r2-secret-access-key>
R2_BUCKET=restaurant-photos
R2_PUBLIC_URL=https://pub-<public-bucket-id>.r2.dev
```

The application reads these variables from `lib/r2.ts` and enables R2 only when the complete configuration is present.

## Upload flow

1. An owner uploads an image through the restaurant photo endpoint.
2. SpotBook uploads the object to R2 under a restaurant-specific path.
3. The public object URL is stored in Deno KV with the restaurant photo metadata.
4. Deleting the photo removes both the database record and the corresponding R2 object.

Typical object URLs look like:

```text
https://pub-<public-bucket-id>.r2.dev/restaurants/<restaurant-id>/<photo-id>.jpg
```

## Verification

At startup, a correctly configured deployment should log:

```text
[R2] ✅ Configured and ready
```

For an end-to-end test, upload an image through the owner UI/API, confirm the response reports R2 storage, fetch the resulting public URL, and then delete the test image through SpotBook.

## Security

- Do not place R2 access keys or secret keys in source files, documentation, screenshots, issues, or commit messages.
- Store production credentials only in the hosting provider's secret manager.
- Rotate a credential immediately if it is ever committed to a public repository.
- Public R2 URLs are intentionally public; API access credentials are not.
