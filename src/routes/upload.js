import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { protect, adminOnly } from '../middleware/auth.js'
const router=Router()
const storage=multer.diskStorage({
  destination:(req,file,cb)=>cb(null,'uploads/'),
  filename:(req,file,cb)=>{ const ext=path.extname(file.originalname); const base=path.basename(file.originalname,ext).replace(/\s+/g,'-').toLowerCase(); cb(null, base+'-'+Date.now()+ext) }
})
const upload=multer({storage})
router.post('/', protect, adminOnly, upload.single('image'), (req,res)=>{ res.status(201).json({url:'/uploads/'+req.file.filename}) })
export default router
