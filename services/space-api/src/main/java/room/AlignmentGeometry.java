package room;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;

/** Validates trusted-worker output before publishing a metric camera calibration. */
final class AlignmentGeometry {
    record Result(ObjectNode geometry,ArrayNode homography,ArrayNode points,double fitErrorMeters) {}
    static Result validate(JsonNode result,int width,int height,TrackingController.Navigation navigation) {
        if(result==null || !result.isObject())throw invalid();
        var g=result.path("geometry");var centre=g.path("center");var k=g.path("intrinsics");
        if(!g.isObject() || !centre.isObject() || !k.isObject() || !"sfm".equals(g.path("source").asText()))throw invalid();
        double x=number(centre,"x"),y=number(centre,"y"),z=number(centre,"z");
        double lowX=Double.POSITIVE_INFINITY,lowZ=Double.POSITIVE_INFINITY,highX=Double.NEGATIVE_INFINITY,highZ=Double.NEGATIVE_INFINITY;
        for(var p:navigation.boundary()) { lowX=Math.min(lowX,p[0]);highX=Math.max(highX,p[0]);lowZ=Math.min(lowZ,p[1]);highZ=Math.max(highZ,p[1]); }
        if(y-navigation.floorY()<0.1 || y-navigation.floorY()>6 || x<lowX-3 || x>highX+3 || z<lowZ-3 || z>highZ+3)
            throw new IllegalArgumentException("Aligned camera is outside the room or has an implausible floor height. Try a clearer room view.");
        var rotation=array(g.path("worldFromCamera"),9);double[] r=new double[9];for(int i=0;i<9;i++)r[i]=rotation.get(i).asDouble();
        for(int row=0;row<3;row++)for(int other=0;other<3;other++) {
            double dot=0;for(int col=0;col<3;col++)dot+=r[row*3+col]*r[other*3+col];
            if(Math.abs(dot-(row==other ? 1:0))>0.02)throw new IllegalArgumentException("Aligned camera rotation is invalid.");
        }
        double determinant=determinant(r);
        if(Math.abs(determinant-1)>0.03)throw new IllegalArgumentException("Aligned camera must use a proper right-handed rotation.");
        double fx=number(k,"fx"),fy=number(k,"fy"),cx=number(k,"cx"),cy=number(k,"cy"),k1=number(k,"k1"),k2=number(k,"k2");
        if(fx<width*0.1 || fx>width*20 || fy<height*0.1 || fy>height*20 || Math.abs(fx/fy-1)>0.03 ||
                cx< -width*0.1 || cx>width*1.1 || cy< -height*0.1 || cy>height*1.1 || Math.abs(k1)>2 || Math.abs(k2)>2)
            throw new IllegalArgumentException("Aligned lens parameters do not match the original live camera image.");
        for(double px:new double[]{0,width})for(double py:new double[]{0,height}) {
            double radiusSquared=Math.pow((px-cx)/fx,2)+Math.pow((py-cy)/fy,2);
            if(1+k1*radiusSquared+k2*radiusSquared*radiusSquared<=0.05 || 1+3*k1*radiusSquared+5*k2*radiusSquared*radiusSquared<=0.05)
                throw new IllegalArgumentException("Aligned lens distortion is unstable near the image edge.");
        }
        var inliers=g.path("inliers");double reprojection=number(g,"reprojectionErrorPx");
        if(!inliers.isIntegralNumber() || !inliers.canConvertToInt() || inliers.asInt()<30 || reprojection<0 || reprojection>5)
            throw new IllegalArgumentException("Camera alignment needs at least 30 reliable background matches and at most five pixels of reprojection error.");
        var homography=array(result.path("homography"),9);double[] h=new double[9];for(int i=0;i<9;i++)h[i]=homography.get(i).asDouble();
        double[] normalized=new double[9];
        for(int row=0;row<3;row++) {
            double scale=Math.max(Math.abs(h[row*3]),Math.max(Math.abs(h[row*3+1]),Math.abs(h[row*3+2])));
            if(scale==0)throw new IllegalArgumentException("Aligned floor projection is invalid.");
            double norm=Math.hypot(Math.hypot(h[row*3]/scale,h[row*3+1]/scale),h[row*3+2]/scale);
            for(int col=0;col<3;col++)normalized[row*3+col]=(h[row*3+col]/scale)/norm;
        }
        if(Math.abs(determinant(normalized))<1e-12)
            throw new IllegalArgumentException("Aligned floor projection is invalid.");
        var points=result.path("points");
        if(!points.isArray() || points.size()>20)throw invalid();
        for(var p:points) {
            double u=number(p.path("image"),"x"),v=number(p.path("image"),"y"),px=number(p.path("world"),"x"),pz=number(p.path("world"),"z");
            if(u<0 || u>1 || v<0 || v>1 || Math.abs(px)>100000 || Math.abs(pz)>100000)throw invalid();
        }
        double error=number(result,"fitErrorMeters");if(error<0 || error>0.2)throw invalid();
        return new Result(((ObjectNode)g).deepCopy(),homography.deepCopy(),((ArrayNode)points).deepCopy(),error);
    }
    private static ArrayNode array(JsonNode node,int size) {
        if(!node.isArray() || node.size()!=size)throw invalid();
        for(var item:node)if(!item.isNumber() || !Double.isFinite(item.asDouble()))throw invalid();
        return (ArrayNode)node;
    }
    private static double number(JsonNode object,String key) {
        var n=object.path(key);if(!n.isNumber() || !Double.isFinite(n.asDouble()))throw invalid();return n.asDouble();
    }
    private static double determinant(double[] a) { return a[0]*(a[4]*a[8]-a[5]*a[7])-a[1]*(a[3]*a[8]-a[5]*a[6])+a[2]*(a[3]*a[7]-a[4]*a[6]); }
    private static IllegalArgumentException invalid() { return new IllegalArgumentException("The camera localizer returned incomplete or invalid geometry. Align again with more static room detail."); }
}
