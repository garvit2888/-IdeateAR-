const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const supabase = require('./supabase-config');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
    storage,
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

// Fix MIME type for .usdz
express.static.mime.define({ 'model/vnd.usdz+zip': ['usdz'] });

// Enable CORS
app.use(cors());
app.use(express.static('public'));

// Health check endpoint
app.get('/health', (req, res) => {
    res.send('OK');
});

// Upload route
app.post('/upload', upload.fields([{ name: 'glb' }, { name: 'usdz' }]), async (req, res) => {
    try {
        const uploadedFiles = {
            glb: null,
            usdz: null
        };

        // Upload files to Supabase Storage
        for (const fileType of ['glb', 'usdz']) {
            if (req.files[fileType]) {
                const file = req.files[fileType][0];
                const filename = `${Date.now()}-${file.originalname}`;
                
                // Upload to Supabase bucket
                const { data, error } = await supabase.storage
                    .from('models')
                    .upload(filename, file.buffer, {
                        contentType: file.mimetype,
                        cacheControl: '3600'
                    });

                if (error) throw error;

                // Get public URL
                const { data: { publicUrl } } = supabase.storage
                    .from('models')
                    .getPublicUrl(filename);

                uploadedFiles[fileType] = publicUrl;
            }
        }

        // Handle auto-conversion if only one file type is uploaded
        if (uploadedFiles.glb && !uploadedFiles.usdz) {
            const usdzFilename = uploadedFiles.glb.split('/').pop().replace('.glb', '.usdz');
            const { data, error } = await supabase.storage
                .from('models')
                .upload(usdzFilename, req.files.glb[0].buffer, {
                    contentType: 'model/vnd.usdz+zip',
                    cacheControl: '3600'
                });

            if (error) throw error;

            const { data: { publicUrl } } = supabase.storage
                .from('models')
                .getPublicUrl(usdzFilename);

            uploadedFiles.usdz = publicUrl;
        } else if (uploadedFiles.usdz && !uploadedFiles.glb) {
            const glbFilename = uploadedFiles.usdz.split('/').pop().replace('.usdz', '.glb');
            const { data, error } = await supabase.storage
                .from('models')
                .upload(glbFilename, req.files.usdz[0].buffer, {
                    contentType: 'model/gltf-binary',
                    cacheControl: '3600'
                });

            if (error) throw error;

            const { data: { publicUrl } } = supabase.storage
                .from('models')
                .getPublicUrl(glbFilename);

            uploadedFiles.glb = publicUrl;
        }

        const viewerLink = `/viewer.html?glb=${uploadedFiles.glb}&usdz=${uploadedFiles.usdz}`;
        res.send(`Your AR viewer link: <a href="${viewerLink}" target="_blank">${viewerLink}</a>`);

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).send('Error processing upload');
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
