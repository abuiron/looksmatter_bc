import mongoose from 'mongoose'
const ProductSchema=new mongoose.Schema({
  name:{type:String,required:true},
  slug:{type:String},
  description:{type:String,default:''},
  image:{type:String,required:true},
  images:[{type:String}],
  price:{type:Number,required:true},
  oldPrice:{type:Number},
  originalPrice:{type:Number},
  category:{type:String,required:true,index:true},
  stock:{type:Number,default:100},
  inStock:{type:Boolean,default:true},
  isSale:{type:Boolean,default:false},
  sku:{type:String},
  // Available sizes for the product. Apparel uses letters (S, M, L, XL, XXL, 3XL, 4XL),
  // footwear uses numbers (6, 7, 8, ...). Empty = product has no size options.
  sizes:[{type:String}],
  tags:[{type:String}]
},{timestamps:true})
export default mongoose.model('Product',ProductSchema)
