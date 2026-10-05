package room;

import java.util.*;

/** Normalized planar least squares. Image coordinates are fractions; output is floor metres. */
final class TrackingHomography {
    record ImagePoint(Double x, Double y) {}
    record FloorPoint(Double x, Double z) {}
    record Pair(ImagePoint image, FloorPoint world) {}
    record Fit(double[] homography, double fitErrorMeters) {}
    private record Normalized(double[][] values, double[] transform) {}

    static Fit fit(List<Pair> points) {
        if (points == null || points.size() < 4 || points.size() > 20)
            throw new IllegalArgumentException("Match between 4 and 20 separate floor points.");
        int count = points.size();
        double[][] image = new double[count][2], world = new double[count][2];
        for (int i = 0; i < count; i++) {
            var p = points.get(i);
            if (p == null || p.image() == null || p.world() == null || p.image().x() == null || p.image().y() == null || p.world().x() == null || p.world().z() == null)
                throw new IllegalArgumentException("Every match needs an image point and a room floor point.");
            double x = p.image().x(), y = p.image().y(), wx = p.world().x(), wz = p.world().z();
            if (!finite(x, y, wx, wz) || x < 0 || x > 1 || y < 0 || y > 1 || Math.abs(wx) > 100000 || Math.abs(wz) > 100000)
                throw new IllegalArgumentException("Use finite normalized image coordinates and metre floor coordinates.");
            image[i] = new double[]{x, y}; world[i] = new double[]{wx, wz};
            for (int j = 0; j < i; j++) {
                if (Math.hypot(x-image[j][0], y-image[j][1]) < 1e-5 || Math.hypot(wx-world[j][0], wz-world[j][1]) < 1e-4)
                    throw new IllegalArgumentException("Each reference point must be distinct in both views.");
            }
        }
        var source = normalize(image); var destination = normalize(world);
        double[][] a = new double[2*count][8]; double[] b = new double[2*count];
        for (int i = 0; i < count; i++) {
            double u=source.values()[i][0], v=source.values()[i][1], x=destination.values()[i][0], z=destination.values()[i][1];
            a[2*i] = new double[]{u,v,1,0,0,0,-x*u,-x*v}; b[2*i]=x;
            a[2*i+1] = new double[]{0,0,0,u,v,1,-z*u,-z*v}; b[2*i+1]=z;
        }
        double[] h = Arrays.copyOf(solve(a,b),9); h[8]=1;
        double determinant = determinant(h);
        if (!Double.isFinite(determinant) || Math.abs(determinant) < 1e-6)
            throw new IllegalArgumentException("The calibration is unstable. Spread matches across the visible floor.");
        double[] target=destination.transform();
        double[] inverseTarget={1/target[0],0,-target[2]/target[0],0,1/target[4],-target[5]/target[4],0,0,1};
        h = multiply(multiply(inverseTarget,h),source.transform());
        double last=h[8];
        if (!Double.isFinite(last) || Math.abs(last) < 1e-10)
            throw new IllegalArgumentException("The calibration crosses a projection singularity. Choose different points.");
        for (int i=0;i<9;i++) { h[i]/=last; if (!Double.isFinite(h[i])) throw new IllegalArgumentException("Invalid floor projection."); }
        double squared=0;
        for (int i=0;i<count;i++) {
            double denominator=h[6]*image[i][0]+h[7]*image[i][1]+1;
            if (Math.abs(denominator)<1e-8) throw new IllegalArgumentException("A reference point is too close to the projection horizon.");
            double x=(h[0]*image[i][0]+h[1]*image[i][1]+h[2])/denominator;
            double z=(h[3]*image[i][0]+h[4]*image[i][1]+h[5])/denominator;
            squared+=(x-world[i][0])*(x-world[i][0])+(z-world[i][1])*(z-world[i][1]);
        }
        double error=Math.sqrt(squared/count);
        if (!Double.isFinite(error) || error>0.20)
            throw new IllegalArgumentException("Reference matches disagree by more than 20 cm. Check the matching points.");
        return new Fit(h,error);
    }

    private static Normalized normalize(double[][] values) {
        double x=0,y=0;
        for (var p:values) { x+=p[0];y+=p[1]; } x/=values.length;y/=values.length;
        double xx=0,yy=0,xy=0,meanDistance=0;
        for (var p:values) { double dx=p[0]-x,dy=p[1]-y;xx+=dx*dx;yy+=dy*dy;xy+=dx*dy;meanDistance+=Math.hypot(dx,dy); }
        double trace=xx+yy, discriminant=Math.sqrt(Math.max(0,(xx-yy)*(xx-yy)+4*xy*xy));
        double largest=(trace+discriminant)/2,smallest=(trace-discriminant)/2;
        if (largest<1e-10 || smallest<largest*1e-4)
            throw new IllegalArgumentException("The floor matches are collinear or too narrow. Use a wide triangle or rectangle.");
        double scale=Math.sqrt(2)/(meanDistance/values.length);
        double[][] normalized=new double[values.length][2];
        for (int i=0;i<values.length;i++) normalized[i]=new double[]{(values[i][0]-x)*scale,(values[i][1]-y)*scale};
        return new Normalized(normalized,new double[]{scale,0,-x*scale,0,scale,-y*scale,0,0,1});
    }

    /** Householder QR with column pivoting avoids the condition-number squaring of normal equations. */
    private static double[] solve(double[][] a,double[] b) {
        int rows=a.length; int[] permutation={0,1,2,3,4,5,6,7}; double maxDiagonal=0,minDiagonal=Double.POSITIVE_INFINITY;
        for (int k=0;k<8;k++) {
            int pivot=k; double best=-1;
            for (int j=k;j<8;j++) { double norm=0;for(int i=k;i<rows;i++) norm+=a[i][j]*a[i][j];if(norm>best){best=norm;pivot=j;} }
            for (int i=0;i<rows;i++) { double tmp=a[i][k];a[i][k]=a[i][pivot];a[i][pivot]=tmp; }
            int tmp=permutation[k];permutation[k]=permutation[pivot];permutation[pivot]=tmp;
            double norm=0;for(int i=k;i<rows;i++) norm=Math.hypot(norm,a[i][k]);
            if (!Double.isFinite(norm) || norm<1e-9) throw new IllegalArgumentException("The matches do not define a stable floor projection.");
            double[] v=new double[rows-k];for(int i=k;i<rows;i++)v[i-k]=a[i][k];v[0]+=Math.copySign(norm,v[0]);
            double vv=0;for(double value:v)vv+=value*value;
            if (vv<1e-18) throw new IllegalArgumentException("The matches do not define a stable floor projection.");
            for(int j=k;j<8;j++) { double dot=0;for(int i=k;i<rows;i++)dot+=v[i-k]*a[i][j];dot*=2/vv;for(int i=k;i<rows;i++)a[i][j]-=dot*v[i-k]; }
            double dot=0;for(int i=k;i<rows;i++)dot+=v[i-k]*b[i];dot*=2/vv;for(int i=k;i<rows;i++)b[i]-=dot*v[i-k];
            double diagonal=Math.abs(a[k][k]);maxDiagonal=Math.max(maxDiagonal,diagonal);minDiagonal=Math.min(minDiagonal,diagonal);
        }
        if (minDiagonal<maxDiagonal*1e-6) throw new IllegalArgumentException("The floor projection is ill-conditioned. Spread the matches further apart.");
        double[] solution=new double[8],result=new double[8];
        for(int i=7;i>=0;i--) { double value=b[i];for(int j=i+1;j<8;j++)value-=a[i][j]*solution[j];solution[i]=value/a[i][i]; }
        for(int i=0;i<8;i++)result[permutation[i]]=solution[i];
        return result;
    }
    private static double determinant(double[] a) { return a[0]*(a[4]*a[8]-a[5]*a[7])-a[1]*(a[3]*a[8]-a[5]*a[6])+a[2]*(a[3]*a[7]-a[4]*a[6]); }
    private static double[] multiply(double[] a,double[] b) { double[] r=new double[9];for(int i=0;i<3;i++)for(int j=0;j<3;j++)for(int k=0;k<3;k++)r[i*3+j]+=a[i*3+k]*b[k*3+j];return r; }
    static boolean finite(double... values) { for(double value:values)if(!Double.isFinite(value))return false;return true; }
}
