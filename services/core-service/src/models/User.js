import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
const AddressSchema=new mongoose.Schema({
  country:String, firstName:String, lastName:String, address1:String, address2:String, city:String, state:String, pin:String, phone:String
},{_id:false})
const CartItemSchema=new mongoose.Schema({ product:{type:mongoose.Schema.Types.ObjectId,ref:'Product',required:true}, qty:{type:Number,default:1}, size:{type:String,default:''}},{_id:false})
const UserSchema=new mongoose.Schema({
  name:{type:String,required:true},
  email:{type:String,required:true,unique:true,index:true},
  password:{type:String,required:true},
  role:{type:String,enum:['user','admin'],default:'user'},
  favorites:[{type:mongoose.Schema.Types.ObjectId,ref:'Product'}],
  cart:[CartItemSchema],
  recentlyViewed:[{type:mongoose.Schema.Types.ObjectId,ref:'Product'}],
  shippingAddress:AddressSchema,
  billingAddress:AddressSchema
},{timestamps:true})
UserSchema.methods.matchPassword=async function(entered){ return bcrypt.compare(entered,this.password) }
UserSchema.pre('save', async function(next){ if(!this.isModified('password')) return next(); const salt=await bcrypt.genSalt(10); this.password=await bcrypt.hash(this.password,salt); next() })
export default mongoose.model('User',UserSchema)
