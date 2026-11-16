import unittest
import numpy as np
import open3d as o3d
from room_worker.geometry import propose_floor


def quad(corners, cells=12):
    a, b, d = (np.array(v, float) for v in corners)
    grid = [a + (b-a)*i/cells + (d-a)*j/cells for j in range(cells+1) for i in range(cells+1)]
    faces = [[j*(cells+1)+i, j*(cells+1)+i+1, (j+1)*(cells+1)+i] for j in range(cells) for i in range(cells)]
    faces += [[j*(cells+1)+i+1, (j+1)*(cells+1)+i+1, (j+1)*(cells+1)+i] for j in range(cells) for i in range(cells)]
    return np.array(grid), np.array(faces)


def room(rotation, parts):
    vertices, faces = [], []
    for corners in parts:
        v, f = quad(corners)
        faces.append(f + sum(map(len, vertices))); vertices.append(v)
    return o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(np.vstack(vertices) @ rotation.T), o3d.utility.Vector3iVector(np.vstack(faces)))


def cameras(rotation, pitch):
    # A person turning on the spot with the phone pitched down: right axes stay level, the mean "up" does not have to.
    poses = []
    for yaw in np.linspace(0, np.pi*1.2, 40):
        forward = np.array([np.sin(yaw)*np.cos(pitch), -np.sin(pitch), np.cos(yaw)*np.cos(pitch)])
        right = np.array([-np.cos(yaw), 0, np.sin(yaw)])
        pose = np.eye(4)
        pose[:3, 0], pose[:3, 1], pose[:3, 2], pose[:3, 3] = right, np.cross(forward, right), forward, [np.sin(yaw)*0.5, 1.5, np.cos(yaw)*0.5]
        pose[:3] = rotation @ pose[:3]
        poses.append(pose)
    return poses


class FloorProposal(unittest.TestCase):
    def setUp(self):
        axis = np.array([1, 0.3, -0.5]) / np.linalg.norm([1, 0.3, -0.5])
        k = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
        self.rotation = np.eye(3) + np.sin(0.9)*k + (1-np.cos(0.9))*k@k
        self.up = self.rotation @ [0, 1, 0]

    def test_slanted_surface_larger_than_the_floor_does_not_tilt_the_room(self):
        floor = [[-2, 0, -2], [2, 0, -2], [-2, 0, 2]]
        slanted = [[-3, 0.2, 2], [3, 0.2, 2], [-3, 2.0, 8]]
        table = [[-1, 0.75, -1], [1, 0.75, -1], [-1, 0.75, 1]]
        wall = [[-2, 0, -2], [2, 0, -2], [-2, 2.6, -2]]
        proposal = propose_floor(room(self.rotation, [floor, slanted, table, wall]), cameras(self.rotation, 0.5), 8)
        self.assertGreater(np.array(proposal["normal"]) @ self.up, np.cos(np.radians(2)))
        self.assertLess(abs(np.array(proposal["point"]) @ self.up), 0.05)
        self.assertGreaterEqual(len(proposal["boundary"]), 3)
        self.assertEqual(len(proposal["floorPoints"]), 3)
        # The cameras were carried 1.5 units above the floor: the capture's own ruler for an automatic room scale.
        self.assertAlmostEqual(proposal["captureHeight"], 1.5, delta=0.06)

    def test_room_without_a_visible_floor_is_still_level(self):
        wall = [[-2, 0.4, -2], [2, 0.4, -2], [-2, 2.6, -2]]
        proposal = propose_floor(room(self.rotation, [wall]), cameras(self.rotation, -0.2), 8)
        self.assertGreater(np.array(proposal["normal"]) @ self.up, np.cos(np.radians(2)))
        self.assertEqual(len(proposal["floorPoints"]), 3)
        self.assertNotIn("boundary", proposal)


if __name__ == "__main__":
    unittest.main()
