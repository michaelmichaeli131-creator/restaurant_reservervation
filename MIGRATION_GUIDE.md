# Database Migration Guide

## Option 1: Keep Deno KV + Add Cloudflare R2 for Images

### **Effort:** Low (2-3 hours)
### **Cost:** Free (10 GB)

### Steps:

1. **Sign up for Cloudflare R2:**
   - Visit: https://dash.cloudflare.com/
   - Create account → R2 → Create bucket: `restaurant-photos`
   - Generate API token

2. **Add to `.env`:**
   ```bash
   R2_ACCOUNT_ID=your_account_id
   R2_ACCESS_KEY=your_access_key
   R2_SECRET_KEY=your_secret_key
   R2_BUCKET=restaurant-photos
   R2_PUBLIC_URL=https://pub-xxxxx.r2.dev
   ```

3. **Install S3 client:**
   ```typescript
   // Add to imports
   import { S3Client, PutObjectCommand } from "npm:@aws-sdk/client-s3";

   const s3 = new S3Client({
     region: "auto",
     endpoint: `https://${Deno.env.get("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
     credentials: {
       accessKeyId: Deno.env.get("R2_ACCESS_KEY")!,
       secretAccessKey: Deno.env.get("R2_SECRET_KEY")!,
     },
   });
   ```

4. **Update `routes/owner_photos.ts`:**
   ```typescript
   // Instead of storing base64 in KV:
   const photoId = crypto.randomUUID();
   const key = `${restaurantId}/${photoId}.jpg`;

   // Upload to R2
   await s3.send(new PutObjectCommand({
     Bucket: Deno.env.get("R2_BUCKET"),
     Key: key,
     Body: bytes,
     ContentType: contentType,
   }));

   // Store URL in KV
   const photoUrl = `${Deno.env.get("R2_PUBLIC_URL")}/${key}`;
   const newPhoto = { id: photoId, url: photoUrl };
   ```

**Pros:**
- ✅ Keep all existing Deno KV code
- ✅ Minimal changes
- ✅ Unlimited photo sizes
- ✅ Works with Deno Deploy

---

## Option 2: Migrate to MongoDB Atlas

### **Effort:** Medium (4-6 hours)
### **Cost:** Free (512 MB)

### Steps:

1. **Create MongoDB Atlas account:**
   - Visit: https://www.mongodb.com/cloud/atlas/register
   - Create free M0 cluster
   - Get connection string

2. **Add to `.env`:**
   ```bash
   MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/restaurant_app
   ```

3. **Install MongoDB driver:**
   ```typescript
   import { MongoClient } from "npm:mongodb@6";

   const client = new MongoClient(Deno.env.get("MONGODB_URI")!);
   await client.connect();
   const db = client.db("restaurant_app");

   export const usersCollection = db.collection("users");
   export const restaurantsCollection = db.collection("restaurants");
   export const reservationsCollection = db.collection("reservations");
   ```

4. **Convert database.ts functions:**

   **Before (Deno KV):**
   ```typescript
   export async function createUser(u) {
     await kv.set(["user", userId], user);
     await kv.set(["user_by_email", email], userId);
   }
   ```

   **After (MongoDB):**
   ```typescript
   export async function createUser(u) {
     await usersCollection.insertOne({
       _id: userId,
       email: u.email,
       // ... rest of fields
     });
     // Email index created automatically
   }
   ```

5. **Create indexes:**
   ```typescript
   await usersCollection.createIndex({ email: 1 }, { unique: true });
   await restaurantsCollection.createIndex({ ownerId: 1 });
   await restaurantsCollection.createIndex({ city: 1 });
   await reservationsCollection.createIndex({ restaurantId: 1, date: 1 });
   ```

**Pros:**
- ✅ Better querying
- ✅ 16 MB photo limit
- ✅ No more KV key patterns

**Cons:**
- ❌ More code changes
- ❌ Network latency
- ❌ External dependency

---

## Option 3: Migrate to Supabase (PostgreSQL + Storage)

### **Effort:** High (1-2 days)
### **Cost:** Free (500 MB database + 1 GB storage)

### Steps:

1. **Create Supabase project:**
   - Visit: https://supabase.com
   - Create new project
   - Get API URL and anon key

2. **Add to `.env`:**
   ```bash
   SUPABASE_URL=https://xxx.supabase.co
   SUPABASE_ANON_KEY=eyJhbGc...
   ```

3. **Create schema (SQL):**
   ```sql
   -- Users table
   CREATE TABLE users (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     email TEXT UNIQUE NOT NULL,
     username TEXT UNIQUE NOT NULL,
     password_hash TEXT,
     role TEXT CHECK (role IN ('user', 'owner')),
     email_verified BOOLEAN DEFAULT false,
     created_at TIMESTAMPTZ DEFAULT NOW()
   );

   -- Restaurants table
   CREATE TABLE restaurants (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     owner_id UUID REFERENCES users(id),
     name TEXT NOT NULL,
     city TEXT,
     address TEXT,
     capacity INTEGER DEFAULT 30,
     approved BOOLEAN DEFAULT false,
     created_at TIMESTAMPTZ DEFAULT NOW()
   );

   -- Reservations table
   CREATE TABLE reservations (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     restaurant_id UUID REFERENCES restaurants(id),
     user_id UUID REFERENCES users(id),
     date DATE NOT NULL,
     time TIME NOT NULL,
     people INTEGER NOT NULL,
     status TEXT DEFAULT 'new',
     created_at TIMESTAMPTZ DEFAULT NOW()
   );
   ```

4. **Use Supabase client:**
   ```typescript
   import { createClient } from "npm:@supabase/supabase-js";

   const supabase = createClient(
     Deno.env.get("SUPABASE_URL")!,
     Deno.env.get("SUPABASE_ANON_KEY")!
   );

   // Create user
   const { data, error } = await supabase
     .from('users')
     .insert({ email, username, password_hash, role });

   // Query restaurants
   const { data: restaurants } = await supabase
     .from('restaurants')
     .select('*')
     .eq('approved', true)
     .ilike('name', `%${searchQuery}%`);
   ```

5. **Upload photos to Supabase Storage (NOT database):**
   ```typescript
   // Upload file
   const { data } = await supabase.storage
     .from('restaurant-photos')
     .upload(`${restaurantId}/${photoId}.jpg`, imageFile, {
       contentType: 'image/jpeg',
       upsert: false
     });

   // Get public URL
   const { data: { publicUrl } } = supabase.storage
     .from('restaurant-photos')
     .getPublicUrl(data.path);

   // Store URL in database
   await supabase.from('restaurants').update({
     photos: [...existingPhotos, publicUrl]
   }).eq('id', restaurantId);
   ```

**Pros:**
- ✅ Proper relational database
- ✅ Built-in authentication (could replace yours)
- ✅ Separate storage for images
- ✅ Real-time subscriptions
- ✅ Admin dashboard

**Cons:**
- ❌ Most work to migrate
- ❌ Need to learn SQL
- ❌ External dependency

---

## Decision Matrix

### Choose **Deno KV + R2** if:
- ✅ You're happy with current code
- ✅ Just need bigger images
- ✅ Want minimal changes

### Choose **MongoDB** if:
- ✅ Need better search/filtering
- ✅ Want document flexibility
- ✅ Comfortable with moderate migration

### Choose **Supabase** if:
- ✅ Want proper relational database
- ✅ Need built-in auth
- ✅ Planning major features (real-time, etc.)
- ✅ Have time for full migration

### Stay with **Deno KV only** if:
- ✅ Thumbnail-sized photos are fine (they are!)
- ✅ Want zero external dependencies
- ✅ Simple deployment is priority

---

## My Recommendation: Deno KV + R2

**Why:**
- Least work (2-3 hours)
- Solves image size problem
- Keeps deployment simple
- No migration risks
- Can still migrate to MongoDB/Supabase later if needed

**You already have a working system - don't over-engineer it!**
