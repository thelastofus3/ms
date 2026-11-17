package room;

import org.junit.jupiter.api.Test;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

class TrackingHomographyCameraTest {
    static final int WIDTH=1280,HEIGHT=720;

    /** A camera at `centre` looking at `target` on the floor, ordinary lens of focal length f; returns pixel coordinates of a floor point. */
    static double[] project(double[] centre,double[] target,double f,double x,double floorY,double z) {
        double[] forward=unit(new double[]{target[0]-centre[0],target[1]-centre[1],target[2]-centre[2]});
        double[] right=unit(cross(forward,new double[]{0,1,0})),down=cross(forward,right);
        double[] d={x-centre[0],floorY-centre[1],z-centre[2]};
        double cx=dot(d,right),cy=dot(d,down),cz=dot(d,forward);
        return new double[]{f*cx/cz+WIDTH/2.0,f*cy/cz+HEIGHT/2.0};
    }
    static List<TrackingHomography.Pair> matches(double[] centre,double[] target,double f,double floorY,double[][] floor,boolean mirrored) {
        var pairs=new ArrayList<TrackingHomography.Pair>();
        for(double[] p:floor) {
            double[] pixel=project(centre,target,f,p[0],floorY,p[1]);
            double u=pixel[0]/WIDTH,v=pixel[1]/HEIGHT;
            pairs.add(new TrackingHomography.Pair(new TrackingHomography.ImagePoint(mirrored ? 1-u:u,v),new TrackingHomography.FloorPoint(p[0],p[1])));
        }
        return pairs;
    }
    static final double[][] FLOOR={{-1,0.5},{1.2,0.4},{1.4,2.6},{-0.8,2.9},{0.2,1.6},{0.9,3.4}};

    @Test void recoversWhereTheCameraStandsAndItsLensFromFloorMatches() {
        double[] centre={2.1,2.45,-1.3},target={0.2,0,1.8};
        var pairs=matches(centre,target,930,0,FLOOR,false);
        var fit=TrackingHomography.fit(pairs);
        var camera=TrackingHomography.camera(fit.homography(),pairs,WIDTH,HEIGHT,0);
        assertNotNull(camera);
        @SuppressWarnings("unchecked") var found=(Map<String,Double>)camera.get("center");
        assertEquals(centre[0],found.get("x"),0.02);assertEquals(centre[1],found.get("y"),0.02);assertEquals(centre[2],found.get("z"),0.02);
        @SuppressWarnings("unchecked") var lens=(Map<String,Double>)camera.get("intrinsics");
        assertEquals(930,lens.get("fx"),9);
        assertEquals("floor-points",camera.get("source"));
        assertTrue((double)camera.get("reprojectionErrorPx")<0.5);
        // The rotation takes the camera's forward axis to the direction it really looks in.
        @SuppressWarnings("unchecked") var r=(List<Double>)camera.get("worldFromCamera");
        double[] forward=unit(new double[]{target[0]-centre[0],target[1]-centre[1],target[2]-centre[2]});
        assertEquals(forward[0],r.get(2),0.01);assertEquals(forward[1],r.get(5),0.01);assertEquals(forward[2],r.get(8),0.01);
    }

    @Test void worksForAFloorThatIsNotAtHeightZero() {
        double[] centre={-2.4,3.1,-1.6},target={0.3,0.7,2.0};
        var pairs=matches(centre,target,760,0.7,FLOOR,false);
        var camera=TrackingHomography.camera(TrackingHomography.fit(pairs).homography(),pairs,WIDTH,HEIGHT,0.7);
        assertNotNull(camera);
        @SuppressWarnings("unchecked") var found=(Map<String,Double>)camera.get("center");
        assertEquals(centre[1],found.get("y"),0.03);assertEquals(centre[0],found.get("x"),0.03);
    }

    @Test void refusesAMirroredImageInsteadOfPlacingTheCameraUnderTheFloor() {
        double[] centre={2.1,2.45,-1.3},target={0.2,0,1.8};
        var pairs=matches(centre,target,930,0,FLOOR,true);
        assertNull(TrackingHomography.camera(TrackingHomography.fit(pairs).homography(),pairs,WIDTH,HEIGHT,0));
    }

    static double dot(double[] a,double[] b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
    static double[] cross(double[] a,double[] b) { return new double[]{a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]}; }
    static double[] unit(double[] a) { double l=Math.sqrt(dot(a,a));return new double[]{a[0]/l,a[1]/l,a[2]/l}; }
}
