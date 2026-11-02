// src/middleware/auth.js
import jwt from 'jsonwebtoken';
export function protect(req,res,next){
  let token=null; const auth=req.headers.authorization;
  if(auth && auth.startsWith('Bearer ')) token=auth.split(' ')[1];
  if(!token) return res.status(401).json({message:'Not authorized, token missing'});
  try{
    const decoded=jwt.verify(token, process.env.JWT_SECRET);
    req.user=decoded; // must contain { id, email, role }
    next();
  } catch {
    return res.status(401).json({message:'Token invalid'});
  }
}
export function adminOnly(req,res,next){
  if(req.user?.role!=='admin') return res.status(403).json({message:'Admin only'});
  next();
}
