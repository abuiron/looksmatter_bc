import User from '../models/User.js'
import { signToken } from '../utils/token.js'
export async function register(req,res){
  try{
    const {name,email,password}=req.body
    if(!name||!email||!password) return res.status(400).json({message:'Missing fields'})
    const exists=await User.findOne({email}); if(exists) return res.status(409).json({message:'Email already registered'})
    const user=await User.create({name,email,password})
    const token=signToken(user); res.status(201).json({token,user:{id:user._id,name:user.name,email:user.email,role:user.role}})
  }catch(err){ res.status(500).json({message:err.message}) }
}
export async function login(req,res){
  try{
    const {email,password}=req.body; const user=await User.findOne({email})
    if(!user) return res.status(401).json({message:'Invalid credentials'})
    const ok=await user.matchPassword(password); if(!ok) return res.status(401).json({message:'Invalid credentials'})
    const token=signToken(user); res.json({token,user:{id:user._id,name:user.name,email:user.email,role:user.role}})
  }catch(err){ res.status(500).json({message:err.message}) }
}
export async function me(req,res){ const user=await User.findById(req.user.id).select('-password'); res.json(user) }
