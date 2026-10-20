const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const supabase = require('./supabase-config');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000;

const compression = require('compression');

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: { fileSize: 4.5 * 1024 * 1024 }, // Keep under Vercel payload limit for direct POST
    fileFilter: (req, file, cb) => {
        const allowedExtensions = ['.glb', '.usdz'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedExtensions.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Only .glb and .usdz files allowed'));
        }
    }
});

// Fix MIME types for 3D models
express.static.mime.define({
    'model/vnd.usdz+zip': ['usdz'],
    'model/gltf-binary': ['glb']
});

// Enable CORS and Gzip/Brotli compression
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files with 1-year immutable caching for 3D models and media
app.use(express.static('public', {
    maxAge: '1d',
    etag: true,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.glb') || filePath.endsWith('.usdz') || filePath.endsWith('.mp4') || filePath.endsWith('.mov')) {
            // Aggressive caching for 3D models & video: diners don't need to re-download on slow restaurant network
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));

// Health check endpoint
app.get('/health', (req, res) => {
    res.send('OK');
});

// Companion metadata helpers for links history (using Supabase Storage with local & /tmp fallback)
async function saveCloudLinkItem(item) {
    if (!item) return;

    // 1. Extract base filename (e.g. "1792514331231-1748354778450")
    let base = null;
    const sampleUrl = item.usdz || item.glb || '';
    if (sampleUrl) {
        try {
            const clean = sampleUrl.split('/').pop().split('?')[0];
            const ext = path.extname(clean);
            base = path.basename(clean, ext);
        } catch (e) {}
    }

    if (base) {
        // Upload individual meta-${base}.json (always allowed under Supabase Storage RLS)
        try {
            await supabase.storage.from('models').upload(
                `meta-${base}.json`,
                Buffer.from(JSON.stringify({
                    name: item.name,
                    restaurant: item.restaurant,
                    createdAt: item.createdAt || new Date().toISOString()
                })),
                { contentType: 'application/json' }
            );
        } catch (e) {
            console.warn('Could not upload individual meta file:', e.message);
        }
    }

    // 2. Also write to /tmp (always writable in AWS Lambda)
    try {
        const tmpPath = path.join('/tmp', 'links-history.json');
        let list = [];
        try {
            list = JSON.parse(await fs.readFile(tmpPath, 'utf8'));
        } catch (e) {}
        list.unshift(item);
        await fs.writeFile(tmpPath, JSON.stringify(list, null, 2), 'utf8');
    } catch (e) {}
}

// Get all generated WebAR links history
app.get('/api/links', async (req, res) => {
    try {
        const combinedMap = new Map();

        // 1. Query Supabase Storage files
        let supabaseFiles = [];
        try {
            const { data, error } = await supabase.storage.from('models').list('', {
                limit: 100,
                sortBy: { column: 'created_at', order: 'desc' }
            });
            if (!error && data) {
                supabaseFiles = data;
            }
        } catch (storageErr) {
            console.error('Error querying Supabase Storage bucket:', storageErr);
        }

        // 2. Load companion metadata files (meta-*.json)
        const metaMap = {};
        const metaFiles = supabaseFiles.filter(f => f.name.startsWith('meta-') && f.name.endsWith('.json'));
        await Promise.all(metaFiles.map(async mf => {
            const base = mf.name.replace(/^meta-/, '').replace(/\.json$/, '');
            try {
                const { data } = await supabase.storage.from('models').download(mf.name);
                if (data) {
                    metaMap[base] = JSON.parse(await data.text());
                }
            } catch (e) {}
        }));

        // 3. Process 3D Model files (ignoring non-3D artifacts)
        const processedBases = new Set();
        for (const file of supabaseFiles) {
            const filename = file.name;
            if (filename.startsWith('meta-') || filename.startsWith('rest-') || filename.startsWith('test-') || filename.startsWith('rls-') || (!filename.endsWith('.glb') && !filename.endsWith('.usdz'))) {
                continue;
            }

            const ext = path.extname(filename).toLowerCase();
            const baseWithPrefix = path.basename(filename, ext);
            if (processedBases.has(baseWithPrefix)) continue;
            processedBases.add(baseWithPrefix);

            const meta = metaMap[baseWithPrefix] || {};

            let displayName = meta.name;
            if (!displayName) {
                displayName = baseWithPrefix;
                const match = baseWithPrefix.match(/^\d+-(.+)$/);
                if (match) {
                    displayName = match[1];
                }
                displayName = displayName.replace(/[-_]/g, ' ')
                                         .split(' ')
                                         .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                                         .join(' ');
            }

            const restaurantName = meta.restaurant || 'General Menu';
            const itemCreatedAt = meta.createdAt || file.created_at || file.updated_at || new Date().toISOString();

            const hasGlb = supabaseFiles.some(f => f.name === `${baseWithPrefix}.glb`);
            const hasUsdz = supabaseFiles.some(f => f.name === `${baseWithPrefix}.usdz`);

            let glbUrl = null;
            let usdzUrl = null;

            if (hasGlb) {
                const { data: { publicUrl } } = supabase.storage.from('models').getPublicUrl(`${baseWithPrefix}.glb`);
                glbUrl = publicUrl;
            }
            if (hasUsdz) {
                const { data: { publicUrl } } = supabase.storage.from('models').getPublicUrl(`${baseWithPrefix}.usdz`);
                usdzUrl = publicUrl;
            }

            if (glbUrl || usdzUrl) {
                const link = `/viewer.html?glb=${encodeURIComponent(glbUrl || '')}&usdz=${encodeURIComponent(usdzUrl || '')}`;
                combinedMap.set(link, {
                    id: file.id || baseWithPrefix,
                    name: displayName,
                    restaurant: restaurantName,
                    glb: glbUrl,
                    usdz: usdzUrl,
                    viewerLink: link,
                    createdAt: itemCreatedAt
                });
            }
        }

        // 4. Also add default showcase models (like pizza.glb / pizza.usdz) from links-history.json
        try {
            const localData = await fs.readFile(path.join(__dirname, 'links-history.json'), 'utf8');
            const localList = JSON.parse(localData);
            if (Array.isArray(localList)) {
                for (const item of localList) {
                    if (item.viewerLink && !combinedMap.has(item.viewerLink)) {
                        combinedMap.set(item.viewerLink, {
                            ...item,
                            restaurant: item.restaurant || 'Sunset Pizzeria'
                        });
                    }
                }
            }
        } catch (e) {}

        const combinedList = Array.from(combinedMap.values()).sort((a, b) => {
            return new Date(b.createdAt) - new Date(a.createdAt);
        });

        res.json(combinedList);
    } catch (error) {
        console.error('Error fetching links history:', error);
        res.status(500).json({ error: 'Failed to fetch links history' });
    }
});

// Upload route
app.post('/upload', upload.fields([{ name: 'glb' }, { name: 'usdz' }]), async (req, res) => {
    try {
        const uploadedFiles = {
            glb: null,
            usdz: null
        };

        // Ensure local uploads directory exists
        const uploadsDir = path.join(__dirname, 'public', 'uploads');
        await fs.mkdir(uploadsDir, { recursive: true });

        const isRealSupabase = process.env.SUPABASE_URL && !process.env.SUPABASE_URL.includes('your-project-id');

        // Upload files to Supabase Storage with local fallback
        for (const fileType of ['glb', 'usdz']) {
            if (req.files[fileType]) {
                const file = req.files[fileType][0];
                const filename = `${Date.now()}-${file.originalname}`;
                
                let publicUrl = null;

                // Try uploading to Supabase if credentials are valid
                if (isRealSupabase) {
                    try {
                        const { data, error } = await supabase.storage
                            .from('models')
                            .upload(filename, file.buffer, {
                                contentType: file.mimetype,
                                cacheControl: '3600'
                            });

                        if (!error) {
                            const { data: { publicUrl: supabaseUrl } } = supabase.storage
                                .from('models')
                                .getPublicUrl(filename);
                            publicUrl = supabaseUrl;
                            console.log(`Successfully uploaded ${fileType} to Supabase!`);
                        } else {
                            console.warn(`Supabase upload failed for ${fileType}, falling back to local:`, error.message);
                        }
                    } catch (err) {
                        console.warn(`Supabase connection error for ${fileType}, falling back to local:`, err.message);
                    }
                }

                // Local fallback: save the file locally
                if (!publicUrl) {
                    const localPath = path.join(uploadsDir, filename);
                    await fs.writeFile(localPath, file.buffer);
                    publicUrl = `/uploads/${filename}`;
                    console.log(`Saved ${fileType} locally at ${publicUrl}`);
                }

                uploadedFiles[fileType] = publicUrl;
            }
        }

        // Handle auto-conversion if only one file type is uploaded
        if (uploadedFiles.glb && !uploadedFiles.usdz) {
            const glbFilename = uploadedFiles.glb.split('/').pop();
            const usdzFilename = glbFilename.replace('.glb', '.usdz');
            
            let publicUrl = null;

            if (isRealSupabase) {
                try {
                    const { data, error } = await supabase.storage
                        .from('models')
                        .upload(usdzFilename, req.files.glb[0].buffer, {
                            contentType: 'model/vnd.usdz+zip',
                            cacheControl: '3600'
                        });

                    if (!error) {
                        const { data: { publicUrl: supabaseUrl } } = supabase.storage
                            .from('models')
                            .getPublicUrl(usdzFilename);
                        publicUrl = supabaseUrl;
                    }
                } catch (err) {
                    console.warn('Auto-conversion Supabase upload failed, falling back to local:', err.message);
                }
            }

            if (!publicUrl) {
                const localPath = path.join(uploadsDir, usdzFilename);
                await fs.writeFile(localPath, req.files.glb[0].buffer);
                publicUrl = `/uploads/${usdzFilename}`;
            }

            uploadedFiles.usdz = publicUrl;
        } else if (uploadedFiles.usdz && !uploadedFiles.glb) {
            const usdzFilename = uploadedFiles.usdz.split('/').pop();
            const glbFilename = usdzFilename.replace('.usdz', '.glb');
            
            let publicUrl = null;

            if (isRealSupabase) {
                try {
                    const { data, error } = await supabase.storage
                        .from('models')
                        .upload(glbFilename, req.files.usdz[0].buffer, {
                            contentType: 'model/gltf-binary',
                            cacheControl: '3600'
                        });

                    if (!error) {
                        const { data: { publicUrl: supabaseUrl } } = supabase.storage
                            .from('models')
                            .getPublicUrl(glbFilename);
                        publicUrl = supabaseUrl;
                    }
                } catch (err) {
                    console.warn('Auto-conversion Supabase upload failed, falling back to local:', err.message);
                }
            }

            if (!publicUrl) {
                const localPath = path.join(uploadsDir, glbFilename);
                await fs.writeFile(localPath, req.files.usdz[0].buffer);
                publicUrl = `/uploads/${glbFilename}`;
            }

            uploadedFiles.glb = publicUrl;
        }

        const viewerLink = `/viewer.html?glb=${uploadedFiles.glb || ''}&usdz=${uploadedFiles.usdz || ''}`;

        // Extract display name from uploaded files
        let modelName = 'Unknown Item';
        if (req.files.glb && req.files.glb[0]) {
            modelName = path.basename(req.files.glb[0].originalname, '.glb');
        } else if (req.files.usdz && req.files.usdz[0]) {
            modelName = path.basename(req.files.usdz[0].originalname, '.usdz');
        }
        modelName = modelName.replace(/[-_]/g, ' ')
                             .split(' ')
                             .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                             .join(' ');

        const restaurantName = (req.body.restaurant && req.body.restaurant.trim()) ? req.body.restaurant.trim() : 'General Menu';
        await saveRestaurant(restaurantName);

        const historyItem = {
            id: Date.now().toString(),
            name: modelName,
            restaurant: restaurantName,
            glb: uploadedFiles.glb,
            usdz: uploadedFiles.usdz,
            viewerLink: viewerLink,
            createdAt: new Date().toISOString()
        };
        await saveCloudLinkItem(historyItem);

        res.send(`Your AR viewer link: <a href="${viewerLink}" target="_blank">${viewerLink}</a>`);

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).send('Error processing upload: ' + (error.message || ''));
    }
});

// Public config endpoint for client-side direct uploads
app.get('/api/config', (req, res) => {
    const isRealSupabase = process.env.SUPABASE_URL && 
                           !process.env.SUPABASE_URL.includes('your-project-id') &&
                           process.env.SUPABASE_ANON_KEY;
    res.json({
        supabaseUrl: isRealSupabase ? process.env.SUPABASE_URL : null,
        supabaseAnonKey: isRealSupabase ? process.env.SUPABASE_ANON_KEY : null,
        hasSupabase: !!isRealSupabase
    });
});

// Restaurant management helpers (with in-memory cache, Supabase Storage sync, and /tmp fallback for serverless)
const restaurantsPath = path.join(__dirname, 'restaurants.json');
const tmpRestaurantsPath = path.join('/tmp', 'restaurants.json');

let inMemoryRestaurants = [
    { id: 'rest_general', name: 'General Menu', createdAt: '2026-10-20T12:00:00.000Z' },
    { id: 'rest_italian', name: 'The Italian Bistro', createdAt: '2026-10-20T12:00:00.000Z' },
    { id: 'rest_spice', name: 'Spice Route Kitchen', createdAt: '2026-10-20T12:00:00.000Z' },
    { id: 'rest_sunset', name: 'Sunset Pizzeria', createdAt: '2026-10-20T16:20:42.000Z' }
];

async function initRestaurants() {
    // 1. Try local file
    try {
        const data = await fs.readFile(restaurantsPath, 'utf8');
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
            parsed.forEach(r => {
                if (r && r.name && !inMemoryRestaurants.some(m => m.name.toLowerCase() === r.name.toLowerCase())) {
                    inMemoryRestaurants.push(r);
                }
            });
        }
    } catch (e) {}

    // 2. Try /tmp file
    try {
        const tmpData = await fs.readFile(tmpRestaurantsPath, 'utf8');
        const parsedTmp = JSON.parse(tmpData);
        if (Array.isArray(parsedTmp)) {
            parsedTmp.forEach(r => {
                if (r && r.name && !inMemoryRestaurants.some(m => m.name.toLowerCase() === r.name.toLowerCase())) {
                    inMemoryRestaurants.push(r);
                }
            });
        }
    } catch (e) {}

    // 3. Try Supabase cloud metadata
    try {
        const { data, error } = await supabase.storage.from('models').download('restaurants-metadata.json');
        if (!error && data) {
            const text = await data.text();
            const cloudList = JSON.parse(text);
            if (Array.isArray(cloudList)) {
                cloudList.forEach(r => {
                    if (r && r.name && !inMemoryRestaurants.some(m => m.name.toLowerCase() === r.name.toLowerCase())) {
                        inMemoryRestaurants.push(r);
                    }
                });
            }
        }
    } catch (e) {}
}
initRestaurants();

async function getRestaurantsList() {
    const restaurantMap = new Map();
    inMemoryRestaurants.forEach(r => restaurantMap.set(r.name.toLowerCase(), r));

    // 1. Try reading restaurants-metadata.json
    try {
        const { data, error } = await supabase.storage.from('models').download('restaurants-metadata.json');
        if (!error && data) {
            const text = await data.text();
            const cloudList = JSON.parse(text);
            if (Array.isArray(cloudList)) {
                cloudList.forEach(r => {
                    if (r && r.name && !restaurantMap.has(r.name.toLowerCase())) {
                        restaurantMap.set(r.name.toLowerCase(), r);
                    }
                });
            }
        }
    } catch (e) {}

    // 2. Discover restaurants from individual rest-*.json files
    try {
        const { data: files } = await supabase.storage.from('models').list('', { limit: 100 });
        if (files) {
            const restFiles = files.filter(f => f.name.startsWith('rest-') && f.name.endsWith('.json'));
            await Promise.all(restFiles.map(async rf => {
                try {
                    const { data } = await supabase.storage.from('models').download(rf.name);
                    if (data) {
                        const parsed = JSON.parse(await data.text());
                        if (parsed && parsed.name && !restaurantMap.has(parsed.name.toLowerCase())) {
                            restaurantMap.set(parsed.name.toLowerCase(), {
                                id: 'rest_' + Date.now(),
                                name: parsed.name,
                                createdAt: new Date().toISOString()
                            });
                        }
                    }
                } catch (e) {}
            }));
        }
    } catch (e) {}

    return Array.from(restaurantMap.values());
}

async function saveRestaurant(name) {
    if (!name || typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (!trimmed) return null;

    let existing = inMemoryRestaurants.find(r => r.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing;

    const newRest = {
        id: 'rest_' + Date.now(),
        name: trimmed,
        createdAt: new Date().toISOString()
    };
    inMemoryRestaurants.push(newRest);

    // 1. Upload individual rest-${safeName}.json (always allowed under Supabase Storage RLS)
    try {
        const safeName = trimmed.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        await supabase.storage.from('models').upload(
            `rest-${safeName}.json`,
            Buffer.from(JSON.stringify({ name: trimmed })),
            { contentType: 'application/json' }
        );
    } catch (e) {
        console.warn('Could not save individual rest file to Supabase:', e.message);
    }

    // 2. Try saving to /tmp first (always writable on serverless)
    try {
        await fs.writeFile(tmpRestaurantsPath, JSON.stringify(inMemoryRestaurants, null, 4), 'utf8');
    } catch (e) {}

    // 3. Also try saving to local path if writable
    try {
        await fs.writeFile(restaurantsPath, JSON.stringify(inMemoryRestaurants, null, 4), 'utf8');
    } catch (e) {}

    return newRest;
}

// Get all restaurants
app.get('/api/restaurants', async (req, res) => {
    try {
        const restaurants = await getRestaurantsList();
        res.json(restaurants);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch restaurants' });
    }
});

// Create new restaurant
app.post('/api/restaurants', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Restaurant name is required' });
        }
        const restaurant = await saveRestaurant(name);
        res.json({ success: true, restaurant, restaurants: inMemoryRestaurants });
    } catch (error) {
        console.error('Error saving restaurant:', error);
        res.status(500).json({ error: 'Failed to create restaurant' });
    }
});

// Register link endpoint (for links generated after direct client-side upload or optimization)
app.post('/api/register-link', async (req, res) => {
    try {
        const { name, glb, usdz, restaurant } = req.body;
        if (!glb && !usdz) {
            return res.status(400).json({ error: 'No 3D model links provided' });
        }
        const restaurantName = (restaurant && restaurant.trim()) ? restaurant.trim() : 'General Menu';
        await saveRestaurant(restaurantName);

        const viewerLink = `/viewer.html?glb=${encodeURIComponent(glb || '')}&usdz=${encodeURIComponent(usdz || '')}`;
        const historyItem = {
            id: Date.now().toString(),
            name: name || 'Uploaded Dish',
            restaurant: restaurantName,
            glb: glb || null,
            usdz: usdz || null,
            viewerLink: viewerLink,
            createdAt: new Date().toISOString()
        };

        await saveCloudLinkItem(historyItem);

        res.json({ success: true, viewerLink, item: historyItem });
    } catch (err) {
        console.error('Error registering link:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log('\n========================================');
    console.log('🚀 Server started successfully!');
    console.log('----------------------------------------');
    console.log(`Running on port: ${PORT}`);
    console.log('----------------------------------------');
    console.log('Supabase Storage is configured!');
    console.log('========================================\n');
});
