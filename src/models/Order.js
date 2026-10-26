import mongoose from 'mongoose'
const OrderItemSchema=new mongoose.Schema({ product:{type:mongoose.Schema.Types.ObjectId,ref:'Product',required:true}, name:String, image:String, price:Number, qty:Number, size:String },{_id:false})
const AddressSchema=new mongoose.Schema({ country:String, firstName:String, lastName:String, address1:String, address2:String, city:String, state:String, pin:String, phone:String },{_id:false})
const OrderSchema=new mongoose.Schema({
  user:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true},
  orderNumber:{type:String,unique:true},
  items:[OrderItemSchema],
  shippingAddress:AddressSchema,
  billingAddress:AddressSchema,
  shippingMethod:{type:String,default:'standard'},
  subtotal:{type:Number,default:0},
  tax:{type:Number,default:0},
  shippingCost:{type:Number,default:0},
  paymentMethod:{type:String,enum:['phonepe','cod','online','PaymentGateway'],default:'cod'},
  paymentStatus:{type:String,enum:['pending','paid','failed','refunded'],default:'pending'},
  paymentIntentId:{type:String},
  paymentRefId:{type:String},
  PaymentGatewayOrderId:{type:String},
  payerVpa:{type:String},
  qrCodeUrl:{type:String},
  estimatedDeliveryDate:{type:Date},
  status:{type:String,enum:['pending','order confirmed','processing','ready to shipment','in transit','out for delivery','delivered','cancelled','refunded'],default:'pending'},
  deletionMessage:{type:String},
  isDeleted:{type:Boolean,default:false},
  total:{type:Number,required:true}
},{timestamps:true})

// Generate order number before saving
OrderSchema.pre('save', async function(next) {
  if (!this.orderNumber) {
    const count = await mongoose.model('Order').countDocuments();
    const timestamp = Date.now().toString().slice(-6);
    this.orderNumber = `ORD${timestamp}${String(count + 1).padStart(4, '0')}`;
  }
  
  // Set estimated delivery date if not set (7 days from order date)
  if (!this.estimatedDeliveryDate && this.isNew) {
    const deliveryDate = new Date();
    deliveryDate.setDate(deliveryDate.getDate() + 7);
    this.estimatedDeliveryDate = deliveryDate;
  }
  
  next();
})
export default mongoose.model('Order',OrderSchema)
