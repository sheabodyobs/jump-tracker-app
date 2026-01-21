#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(RealFrameProvider, NSObject)

RCT_EXTERN_METHOD(sampleFrames:(NSString *)videoUri
                  timestampsMs:(NSArray<NSNumber *> *)timestampsMs
                  options:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
