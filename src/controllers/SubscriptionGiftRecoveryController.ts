import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { GiftShopifyClient, type GiftShopifyCallError } from "../gifts/subscription-gift.shopify.client";
const ALLOWED_JOB_ID = "cmu5q5t5e0003jw04zv6faoqy";
const GIFT_VARIANT_ID = "gid://shopify/ProductVariant/53775084388715";
function authorized(request: Request): boolean { const expected=(process.env.CRON_SECRET??"").trim(), received=String(request.headers.authorization??"").replace(/^Bearer\s+/i,"").trim(); return Boolean(expected)&&Buffer.byteLength(expected)===Buffer.byteLength(received)&&timingSafeEqual(Buffer.from(expected),Buffer.from(received)); }
export class SubscriptionGiftRecoveryController {
  constructor(private readonly prisma=new PrismaClient(), private readonly shopify=new GiftShopifyClient()) {}
  async run(request: Request, response: Response) {
    try {
      if (!authorized(request)) return response.status(401).json({error:"unauthorized"});
      const jobId=typeof request.query.jobId==="string"?request.query.jobId:""; if(jobId!==ALLOWED_JOB_ID) return response.status(404).json({error:"recovery_not_found"});
      let job; try { job=await this.prisma.subscriptionGiftJob.findUnique({where:{id:ALLOWED_JOB_ID},include:{shop:{select:{domain:true,accessToken:true}}}}); } catch { return this.fail(response,"database",request); }
      if(!job) return response.status(404).json({error:"job_not_found",stage:"job_state"});
      if(job.status==="COMMITTED"&&job.resultCode==="recovered_from_commit_pending") return response.status(200).json({success:true,idempotent:true,status:job.status,processedAt:job.processedAt});
      if(job.status!=="COMMIT_PENDING") return response.status(409).json({error:"job_not_commit_pending",stage:"job_state",status:job.status});
      let lines; try { lines=await this.shopify.queryOrderGiftLines(job.shop.domain,job.shop.accessToken,job.orderId,GIFT_VARIANT_ID); } catch(error) { return this.fail(response,"shopify_read",request,job.orderId,job.shop.domain,error); }
      const hasPaidLine=lines.some(line=>line.discountedUnitPrice>0), freeLine=lines.find(line=>line.discountedUnitPrice===0); if(!hasPaidLine||!freeLine) return response.status(409).json({error:"confirmation_missing",stage:"confirmation_missing",orderId:job.orderId});
      const processedAt=new Date(); let claimed; try { claimed=await this.prisma.subscriptionGiftJob.updateMany({where:{id:ALLOWED_JOB_ID,status:"COMMIT_PENDING"},data:{status:"COMMITTED",resultCode:"recovered_from_commit_pending",resultMessage:`Recovery confirmou linha gratuita existente: ${freeLine.title}.`,giftLineIdentifier:freeLine.lineId,processedAt,claimToken:null,claimedAt:null,leaseExpiresAt:null}}); } catch { return this.fail(response,"database",request,job.orderId,job.shop.domain); }
      if(claimed.count===0){let current; try {current=await this.prisma.subscriptionGiftJob.findUnique({where:{id:ALLOWED_JOB_ID},select:{status:true,processedAt:true,resultCode:true}});} catch{return this.fail(response,"database",request,job.orderId,job.shop.domain);} return response.status(200).json({success:current?.status==="COMMITTED",idempotent:true,...current});}
      return response.status(200).json({success:true,idempotent:false,status:"COMMITTED",processedAt,resultCode:"recovered_from_commit_pending"});
    } catch { return this.fail(response,"job_state",request); }
  }
  private fail(response:Response,stage:"shopify_read"|"database"|"job_state",request:Request,orderId?:string,shop?:string,cause?:unknown){const error=cause as Partial<GiftShopifyCallError>|undefined,status=error?.status,errorCode=stage==="shopify_read"?(status===401?"shopify_401":status===403?"shopify_403":status===404?"shopify_404":error?.kind==="graphql_error"?"graphql_error":error?.kind==="network"||error?.kind==="timeout"?"network":"shopify_read_failed"): `recovery_${stage}_failed`,requestId=String(request.headers["x-request-id"]??request.headers["x-vercel-id"]??"unknown"); console.error("[GiftRecovery] failed",{stage,errorCode,httpStatus:status,graphqlCodes:error?.graphqlCodes??[],orderId,shop,requestId}); return response.status(502).json({error:errorCode,stage,requestId,...(orderId?{orderId}:{})});}
}
