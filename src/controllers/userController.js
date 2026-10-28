// src/controllers/userController.js
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import { findLiveProducts, isObjectId, resolveCartLines, toQuantity } from '../utils/cart.js';

export async function getProfile(req,res){
  const user=await User.findById(req.user.id).select('-password');
  res.json(user);
}

export async function updateProfile(req,res){
  const {name,shippingAddress,billingAddress,currentPassword,newPassword}=req.body;
  const user=await User.findById(req.user.id);
  if(!user) return res.status(404).json({message:'User not found'});

  if (name) user.name=name;
  if (shippingAddress) user.shippingAddress=shippingAddress;
  if (billingAddress) user.billingAddress=billingAddress;

  // Password change flow
  if (currentPassword || newPassword) {
    if (!currentPassword || !newPassword) {
      return res.status(400).json({message:'Both currentPassword and newPassword are required'});
    }
    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) return res.status(400).json({message:'Current password is incorrect'});
    if (String(newPassword).length < 8) return res.status(400).json({message:'New password must be at least 8 characters'});
    user.password = await bcrypt.hash(newPassword, 10);
  }

  await user.save();
  const safe = await User.findById(user._id).select('-password');
  res.json(safe);
}

// Products can be deleted (or re-imported with new ids) while they still sit in
// someone's wishlist, bag or history. Reads below resolve ids against the live
// catalogue, return only products that exist, and prune the dead ids for good.
const PRODUCT_GONE = 'This product is no longer available';

// Favorites
export async function getFavorites(req,res){
  try {
    const user=await User.findById(req.user.id).select('favorites').lean();
    if(!user) return res.status(404).json({message:'User not found'});
    const ids=(user.favorites||[]).map(String);
    const {byId,missingIds}=await findLiveProducts(ids);
    if(missingIds.length){
      await User.updateOne({_id:user._id},{$pull:{favorites:{$in:missingIds}}});
    }
    res.json(ids.map(id=>byId.get(id)).filter(Boolean));
  } catch (err) {
    console.error('getFavorites error:', err);
    res.status(500).json({message:'Failed to load favorites'});
  }
}
// POST adds and DELETE removes. Both are idempotent, so a retried request can
// never flip the state the wrong way (the old shared toggle could re-add on DELETE).
export async function addFavorite(req,res){
  try {
    const {productId}=req.params;
    if(!isObjectId(productId)) return res.status(400).json({message:'Invalid product id'});
    if(!(await Product.exists({_id:productId}))) return res.status(404).json({message:PRODUCT_GONE});
    const user=await User.findByIdAndUpdate(req.user.id,{$addToSet:{favorites:productId}},{new:true}).select('favorites');
    if(!user) return res.status(404).json({message:'User not found'});
    res.json(user.favorites);
  } catch (err) {
    console.error('addFavorite error:', err);
    res.status(500).json({message:'Failed to update favorites'});
  }
}
export async function removeFavorite(req,res){
  try {
    const {productId}=req.params;
    if(!isObjectId(productId)) return res.status(400).json({message:'Invalid product id'});
    const user=await User.findByIdAndUpdate(req.user.id,{$pull:{favorites:productId}},{new:true}).select('favorites');
    if(!user) return res.status(404).json({message:'User not found'});
    res.json(user.favorites);
  } catch (err) {
    console.error('removeFavorite error:', err);
    res.status(500).json({message:'Failed to update favorites'});
  }
}

// Cart
// A product can appear multiple times in the cart with different sizes, so cart
// lines are identified by product + size. `normSize` keeps '' and undefined equal.
const normSize = (s) => (s === undefined || s === null ? '' : String(s));

export async function getCart(req,res){
  try {
    const user=await User.findById(req.user.id).select('cart').lean();
    if(!user) return res.status(404).json({message:'User not found'});
    const {lines,missingIds}=await resolveCartLines(user.cart||[]);
    if(missingIds.length){
      await User.updateOne({_id:user._id},{$pull:{cart:{product:{$in:missingIds}}}});
    }
    // Same shape as before: [{ product: <product>, qty, size }]
    res.json(lines);
  } catch (err) {
    console.error('getCart error:', err);
    res.status(500).json({message:'Failed to load cart'});
  }
}
export async function addToCart(req,res){
  try {
    const {productId,qty=1,size=''}=req.body||{};
    if(!isObjectId(productId)) return res.status(400).json({message:'Invalid product id'});
    const amount=toQuantity(qty);
    if(!amount) return res.status(400).json({message:'Quantity must be at least 1'});
    // Only live products can enter the bag, so orders never reference deleted ones.
    if(!(await Product.exists({_id:productId}))) return res.status(404).json({message:PRODUCT_GONE});
    const user=await User.findById(req.user.id);
    if(!user) return res.status(404).json({message:'User not found'});
    const s=normSize(size);
    const found=user.cart.find(ci=>ci.product.toString()===productId && normSize(ci.size)===s);
    if(found) found.qty+=amount; else user.cart.push({product:productId,qty:amount,size:s});
    await user.save(); res.status(201).json(user.cart);
  } catch (err) {
    console.error('addToCart error:', err);
    res.status(500).json({message:'Failed to add to cart'});
  }
}
export async function updateCartItem(req,res){
  try {
    const {productId}=req.params; const {qty,size}=req.body||{};
    const amount=toQuantity(qty);
    if(!amount) return res.status(400).json({message:'Quantity must be at least 1'});
    const user=await User.findById(req.user.id);
    if(!user) return res.status(404).json({message:'User not found'});
    // Match the exact product+size line; fall back to product-only when size is omitted.
    const found=user.cart.find(ci=>ci.product.toString()===productId && (size===undefined || normSize(ci.size)===normSize(size)));
    if(!found) return res.status(404).json({message:'Item not in cart'});
    found.qty=amount; await user.save(); res.json(user.cart);
  } catch (err) {
    console.error('updateCartItem error:', err);
    res.status(500).json({message:'Failed to update cart'});
  }
}
export async function removeCartItem(req,res){
  try {
    const {productId}=req.params; const {size}=req.query; const user=await User.findById(req.user.id);
    if(!user) return res.status(404).json({message:'User not found'});
    user.cart=user.cart.filter(ci=>!(ci.product.toString()===productId && (size===undefined || normSize(ci.size)===normSize(size))));
    await user.save(); res.json(user.cart);
  } catch (err) {
    console.error('removeCartItem error:', err);
    res.status(500).json({message:'Failed to update cart'});
  }
}
export async function clearCart(req,res){
  try {
    await User.updateOne({_id:req.user.id},{$set:{cart:[]}});
    res.json([]);
  } catch (err) {
    console.error('clearCart error:', err);
    res.status(500).json({message:'Failed to clear cart'});
  }
}

// Recently viewed
export async function pushRecently(req,res){
  try {
    const {productId}=req.params;
    if(!isObjectId(productId)) return res.status(400).json({message:'Invalid product id'});
    const user=await User.findById(req.user.id);
    if(!user) return res.status(404).json({message:'User not found'});
    user.recentlyViewed=[productId, ...user.recentlyViewed.filter(id=>id.toString()!==productId)].slice(0,20);
    await user.save(); res.json(user.recentlyViewed);
  } catch (err) {
    console.error('pushRecently error:', err);
    res.status(500).json({message:'Failed to update recently viewed'});
  }
}
export async function getRecently(req,res){
  try {
    const user=await User.findById(req.user.id).select('recentlyViewed').lean();
    if(!user) return res.status(404).json({message:'User not found'});
    const ids=(user.recentlyViewed||[]).map(String);
    const {byId,missingIds}=await findLiveProducts(ids);
    if(missingIds.length){
      await User.updateOne({_id:user._id},{$pull:{recentlyViewed:{$in:missingIds}}});
    }
    res.json(ids.map(id=>byId.get(id)).filter(Boolean));
  } catch (err) {
    console.error('getRecently error:', err);
    res.status(500).json({message:'Failed to load recently viewed'});
  }
}

// Admin
export async function adminListUsers(req,res){
  const users = await User.find({}).select('-password').sort({createdAt:-1}).limit(500);
  res.json(users);
}
export async function adminGetUserById(req,res){
  const u = await User.findById(req.params.id).select('-password');
  if(!u) return res.status(404).json({message:'User not found'});
  res.json(u);
}

/** GET /api/users/admin/:id/orders - Get user's order statistics (admin only) */
export async function adminGetUserOrders(req, res) {
  try {
    const { id } = req.params;
    
    // Get all orders for this user
    const orders = await Order.find({ user: id })
      .select('orderNumber total status paymentStatus createdAt items')
      .sort({ createdAt: -1 });
    
    // Calculate statistics
    const totalOrders = orders.length;
    const successfulOrders = orders.filter(o => o.status === 'delivered').length;
    const pendingOrders = orders.filter(o => 
      o.status !== 'delivered' && 
      o.status !== 'cancelled' && 
      o.status !== 'refunded'
    ).length;
    const cancelledOrders = orders.filter(o => 
      o.status === 'cancelled' || o.status === 'refunded'
    ).length;
    
    const totalSpent = orders
      .filter(o => o.paymentStatus === 'paid')
      .reduce((sum, o) => sum + o.total, 0);
    
    res.json({
      totalOrders,
      successfulOrders,
      pendingOrders,
      cancelledOrders,
      totalSpent,
      orders: orders.slice(0, 10), // Return last 10 orders
    });
  } catch (err) {
    console.error('adminGetUserOrders error:', err);
    res.status(500).json({ message: 'Failed to fetch user orders' });
  }
}
