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

// Get all generated WebAR links history
app.get('/api/links', async (req, res) => {
    try {
        const historyPath = path.join(__dirname, 'links-history.json');
        let localHistory = [];
        try {
            const data = await fs.readFile(historyPath, 'utf8');
            localHistory = JSON.parse(data);
        } catch (readErr) {
            // Keep empty array
        }

        // Fallback/Dynamic Sync: Query Supabase Storage to check what files exist
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

        // Group files by base name to reconstruct dynamic history from Supabase bucket
        const supabaseHistory = [];
        const processedBases = new Set();

        for (const file of supabaseFiles) {
            const filename = file.name;
            if (filename === '.emptyFolderPlaceholder' || (!filename.endsWith('.glb') && !filename.endsWith('.usdz'))) {
                continue;
            }

            // Filename format: e.g. "1716724000-burger.glb" or "burger.glb"
            const ext = path.extname(filename).toLowerCase();
            const baseWithPrefix = path.basename(filename, ext);
            
            if (processedBases.has(baseWithPrefix)) continue;
            processedBases.add(baseWithPrefix);

            // Extract display name by removing the leading digits/timestamp prefix if present
            let displayName = baseWithPrefix;
            const match = baseWithPrefix.match(/^\d+-(.+)$/);
            if (match) {
                displayName = match[1];
            }
            displayName = displayName.replace(/[-_]/g, ' ')
                                     .split(' ')
                                     .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                                     .join(' ');

            // Find GLB and USDZ files with this base in the bucket list
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
                supabaseHistory.push({
                    id: file.id || baseWithPrefix,
                    name: displayName,
                    restaurant: 'General Menu',
                    glb: glbUrl,
                    usdz: usdzUrl,
                    viewerLink: `/viewer.html?glb=${glbUrl || ''}&usdz=${usdzUrl || ''}`,
                    createdAt: file.created_at || file.updated_at || new Date().toISOString()
                });
            }
        }

        // Combine local JSON history and Supabase dynamic history
        const combinedMap = new Map();

        // 1. Add Supabase history first
        for (const item of supabaseHistory) {
            combinedMap.set(item.viewerLink, item);
        }

        // 2. Add Local JSON history (preserves explicit restaurant assignments)
        for (const item of localHistory) {
            item.restaurant = item.restaurant || 'General Menu';
            combinedMap.set(item.viewerLink, item);
        }

        // Convert map back to list and sort by createdAt descending
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

        try {
            const historyPath = path.join(__dirname, 'links-history.json');
            let history = [];
            try {
                const data = await fs.readFile(historyPath, 'utf8');
                history = JSON.parse(data);
            } catch (readErr) {
                // If file doesn't exist, use empty array
            }
            history.unshift(historyItem);
            await fs.writeFile(historyPath, JSON.stringify(history, null, 4), 'utf8');
        } catch (writeErr) {
            console.error('Error writing link history:', writeErr);
        }

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

// Restaurant management helpers
const restaurantsPath = path.join(__dirname, 'restaurants.json');

async function getRestaurantsList() {
    let list = [];
    try {
        const data = await fs.readFile(restaurantsPath, 'utf8');
        list = JSON.parse(data);
    } catch (e) {
        list = [
            { id: 'rest_general', name: 'General Menu', createdAt: new Date().toISOString() }
        ];
    }
    return list;
}

async function saveRestaurant(name) {
    if (!name || typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (!trimmed) return null;

    let list = await getRestaurantsList();
    const existing = list.find(r => r.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing;

    const newRest = {
        id: 'rest_' + Date.now(),
        name: trimmed,
        createdAt: new Date().toISOString()
    };
    list.push(newRest);
    try {
        await fs.writeFile(restaurantsPath, JSON.stringify(list, null, 4), 'utf8');
    } catch (err) {
        console.error('Error writing restaurants.json:', err);
    }
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
        const all = await getRestaurantsList();
        res.json({ success: true, restaurant, restaurants: all });
    } catch (error) {
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

        const historyPath = path.join(__dirname, 'links-history.json');
        let history = [];
        try {
            const data = await fs.readFile(historyPath, 'utf8');
            history = JSON.parse(data);
        } catch (readErr) {}
        
        history.unshift(historyItem);
        await fs.writeFile(historyPath, JSON.stringify(history, null, 4), 'utf8');

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
